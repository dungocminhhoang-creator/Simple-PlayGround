// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Native SRW pool contract for Simple Playground with player balances, gasless relayed play, and wallet-signed fallback play.
/// @dev Production deployments should still be audited. The commit/reveal flow reduces but does not eliminate
/// relayer censorship risk; a relayer can refuse to submit a completed round. Direct wallet play is a fallback
/// for relayer downtime and uses on-chain block entropy, which is weaker than the relayed commit/reveal path.
contract SimplePlayground {
    enum GameType {
        CoinFlip,
        Rps
    }

    enum Result {
        Lose,
        Win,
        Draw
    }

    struct Round {
        address player;
        GameType gameType;
        uint256 betAmount;
        uint8 playerMove;
        uint8 outcome;
        Result result;
        uint256 payout;
        uint256 entryFee;
        uint256 winFee;
    }

    struct RelayedPlay {
        address player;
        uint8 gameType;
        uint8 playerMove;
        uint256 betAmount;
        bytes32 playerSeed;
        uint256 sessionAllowance;
        uint64 sessionExpiresAt;
        uint256 sessionNonce;
        bytes sessionSignature;
        bytes32 serverSeed;
        bytes32 nextServerSeedHash;
    }

    struct CatRaceRoundView {
        uint256 raceId;
        uint8 phase;
        uint256 startedAt;
        uint256 bettingEndsAt;
        uint256 endsAt;
        uint8 winnerCat;
        uint256[5] totalBets;
    }

    address public owner;
    uint16 public entryFeeBps = 500;
    uint16 public winFeeBps = 500;
    uint256 public minBet = 0.01 ether;
    uint256 public maxBet = 100 ether;
    uint256 public nextRoundId = 1;
    uint256 public totalPlayerBalances;
    uint256 public immutable leaderboardGenesis;
    uint256 public immutable catRaceGenesis;
    uint256 public leaderboardEpochDuration = 5 days;
    uint256 public catRacePrepareDuration = 30 seconds;
    uint256 public catRaceRunDuration = 90 seconds;
    uint256 public constant MIN_LEADERBOARD_GAMES = 100;

    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 public constant SESSION_TYPEHASH =
        keccak256("Session(address player,address relayer,uint256 allowance,uint64 expiresAt,uint256 nonce)");

    mapping(address => bool) public trustedRelayers;
    mapping(address => uint256) public playerBalances;
    mapping(bytes32 => uint256) public sessionSpent;
    mapping(bytes32 => bool) public serverSeedCommitments;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => int256)) public epochNetProfit;
    mapping(uint256 => mapping(address => uint256)) public epochPlayCount;
    mapping(uint256 => address[10]) private epochTopPlayers;
    mapping(uint256 => bool) public epochRewardsSettled;
    uint256[10] private leaderboardRewardAmounts;
    mapping(uint256 => mapping(uint8 => uint256)) public catRaceTotalBets;
    mapping(uint256 => mapping(address => mapping(uint8 => uint256))) public catRacePlayerBets;
    mapping(uint256 => mapping(address => bool)) public catRaceClaimed;
    mapping(address => uint256) public catRaceWonTotals;
    address[10] private catRaceTopPlayers;

    event OwnerChanged(address indexed previousOwner, address indexed nextOwner);
    event TrustedRelayerUpdated(address indexed relayer, bool trusted);
    event FeesUpdated(uint16 entryFeeBps, uint16 winFeeBps);
    event BetLimitsUpdated(uint256 minBet, uint256 maxBet);
    event PoolDeposited(address indexed from, uint256 amount);
    event PoolWithdrawn(address indexed to, uint256 amount);
    event PlayerDeposited(address indexed player, uint256 amount, uint256 balance);
    event PlayerWithdrawn(address indexed player, uint256 amount, uint256 balance);
    event ServerSeedCommitted(bytes32 indexed serverSeedHash, address indexed relayer);
    event ServerSeedRevealed(bytes32 indexed serverSeedHash, bytes32 indexed nextServerSeedHash, address indexed relayer);
    event RoundSettled(
        uint256 indexed roundId,
        address indexed player,
        uint8 gameType,
        uint256 betAmount,
        uint8 playerMove,
        uint8 outcome,
        uint8 result,
        uint256 payout
    );
    event RoundRandomness(uint256 indexed roundId, bytes32 indexed playerSeed, bytes32 indexed serverSeedHash);
    event LeaderboardUpdated(uint256 indexed epoch, address indexed player, int256 netProfit);
    event LeaderboardRewardPaid(uint256 indexed epoch, uint8 rank, address indexed player, uint256 amount);
    event LeaderboardRewardsSettled(uint256 indexed epoch, uint256 totalRewards);
    event LeaderboardRewardUpdated(uint8 indexed rank, uint256 amount);
    event LeaderboardCycleUpdated(uint256 duration);
    event CatRaceBetPlaced(uint256 indexed raceId, address indexed player, uint8 indexed cat, uint256 amount);
    event CatRaceSettled(uint256 indexed raceId, address indexed player, uint8 indexed winnerCat, uint256 payout);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyTrustedRelayer() {
        require(trustedRelayers[msg.sender], "not relayer");
        _;
    }

    constructor() {
        owner = msg.sender;
        leaderboardGenesis = block.timestamp;
        catRaceGenesis = block.timestamp;
        leaderboardRewardAmounts[0] = 3 ether;
        leaderboardRewardAmounts[1] = 2 ether;
        leaderboardRewardAmounts[2] = 2 ether;
        for (uint256 i = 3; i < 10; i++) {
            leaderboardRewardAmounts[i] = 1 ether;
        }
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("SimplePlayground")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        emit OwnerChanged(address(0), msg.sender);
    }

    receive() external payable {
        emit PoolDeposited(msg.sender, msg.value);
    }

    function poolLiquidity() public view returns (uint256) {
        return address(this).balance - totalPlayerBalances;
    }

    function sessionHash(
        address player,
        address relayer,
        uint256 allowance,
        uint64 expiresAt,
        uint256 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(SESSION_TYPEHASH, player, relayer, allowance, expiresAt, nonce));
    }

    function sessionDigest(
        address player,
        address relayer,
        uint256 allowance,
        uint64 expiresAt,
        uint256 nonce
    ) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, sessionHash(player, relayer, allowance, expiresAt, nonce)));
    }

    function currentLeaderboardEpoch() public view returns (uint256) {
        return ((block.timestamp - leaderboardGenesis) / leaderboardEpochDuration) + 1;
    }

    function leaderboardEpochBounds(uint256 epoch) public view returns (uint256 startedAt, uint256 endsAt) {
        require(epoch > 0, "zero epoch");
        startedAt = leaderboardGenesis + ((epoch - 1) * leaderboardEpochDuration);
        endsAt = startedAt + leaderboardEpochDuration;
    }

    function leaderboardRewardsInfo() external view returns (uint256[10] memory rewards) {
        for (uint256 i = 0; i < 10; i++) {
            rewards[i] = leaderboardRewardAmounts[i];
        }
    }

    function currentCatRaceId() public view returns (uint256) {
        return ((block.timestamp - catRaceGenesis) / _catRaceCycleDuration()) + 1;
    }

    function catRaceRoundBounds(uint256 raceId)
        public
        view
        returns (uint256 startedAt, uint256 bettingEndsAt, uint256 endsAt)
    {
        require(raceId > 0, "zero race");
        startedAt = catRaceGenesis + ((raceId - 1) * _catRaceCycleDuration());
        bettingEndsAt = startedAt + catRacePrepareDuration;
        endsAt = bettingEndsAt + catRaceRunDuration;
    }

    function catRaceCurrentInfo() external view returns (CatRaceRoundView memory info) {
        return catRaceRoundInfo(currentCatRaceId());
    }

    function catRaceRoundInfo(uint256 raceId) public view returns (CatRaceRoundView memory info) {
        (uint256 startedAt, uint256 bettingEndsAt, uint256 endsAt) = catRaceRoundBounds(raceId);
        uint8 phase = block.timestamp < bettingEndsAt ? 0 : block.timestamp < endsAt ? 1 : 2;
        uint256[5] memory totals;
        for (uint8 i = 0; i < 5; i++) {
            totals[i] = catRaceTotalBets[raceId][i];
        }
        info = CatRaceRoundView({
            raceId: raceId,
            phase: phase,
            startedAt: startedAt,
            bettingEndsAt: bettingEndsAt,
            endsAt: endsAt,
            winnerCat: _catRaceWinner(raceId),
            totalBets: totals
        });
    }

    function catRaceLeaderboardInfo() external view returns (address[10] memory players, uint256[10] memory wonTotals) {
        players = catRaceTopPlayers;
        for (uint256 i = 0; i < 10; i++) {
            wonTotals[i] = players[i] == address(0) ? uint256(0) : catRaceWonTotals[players[i]];
        }
    }

    function leaderboardEpochInfo(uint256 epoch)
        external
        view
        returns (
            address[10] memory players,
            int256[10] memory profits,
            uint256[10] memory playCounts,
            uint256 startedAt,
            uint256 endsAt,
            bool rewardsSettled
        )
    {
        require(epoch > 0, "zero epoch");
        players = epochTopPlayers[epoch];
        for (uint256 i = 0; i < 10; i++) {
            profits[i] = players[i] == address(0) ? int256(0) : epochNetProfit[epoch][players[i]];
            playCounts[i] = players[i] == address(0) ? uint256(0) : epochPlayCount[epoch][players[i]];
        }
        (startedAt, endsAt) = leaderboardEpochBounds(epoch);
        rewardsSettled = epochRewardsSettled[epoch];
    }

    function settleLeaderboardRewards(uint256 epoch) external {
        require(epoch > 0 && epoch < currentLeaderboardEpoch(), "epoch active");
        require(!epochRewardsSettled[epoch], "already settled");

        address[10] storage players = epochTopPlayers[epoch];
        uint256 totalRewards = 0;
        for (uint8 i = 0; i < 10; i++) {
            if (!_isLeaderboardRewardEligible(epoch, players[i])) {
                continue;
            }
            totalRewards += _leaderboardReward(i);
        }

        require(totalRewards > 0, "no winners");
        require(poolLiquidity() >= totalRewards, "pool too low");
        epochRewardsSettled[epoch] = true;

        for (uint8 i = 0; i < 10; i++) {
            address player = players[i];
            if (!_isLeaderboardRewardEligible(epoch, player)) {
                continue;
            }
            uint256 reward = _leaderboardReward(i);
            (bool sent, ) = payable(player).call{value: reward}("");
            require(sent, "reward failed");
            emit LeaderboardRewardPaid(epoch, i + 1, player, reward);
        }

        emit LeaderboardRewardsSettled(epoch, totalRewards);
    }

    function setLeaderboardRewards(uint256[10] calldata rewards) external onlyOwner {
        for (uint8 i = 0; i < 10; i++) {
            leaderboardRewardAmounts[i] = rewards[i];
            emit LeaderboardRewardUpdated(i + 1, rewards[i]);
        }
    }

    function setLeaderboardCycleDays(uint16 cycleDays) external onlyOwner {
        require(cycleDays > 0 && cycleDays <= 365, "invalid cycle");
        leaderboardEpochDuration = uint256(cycleDays) * 1 days;
        emit LeaderboardCycleUpdated(leaderboardEpochDuration);
    }

    function placeCatRaceBet(uint8 cat, uint256 betAmount) external returns (uint256 raceId) {
        require(cat < 5, "invalid cat");
        raceId = currentCatRaceId();
        (, uint256 bettingEndsAt, ) = catRaceRoundBounds(raceId);
        require(block.timestamp < bettingEndsAt, "betting closed");

        _chargePlayer(msg.sender, betAmount);
        catRacePlayerBets[raceId][msg.sender][cat] += betAmount;
        catRaceTotalBets[raceId][cat] += betAmount;

        emit CatRaceBetPlaced(raceId, msg.sender, cat, betAmount);
    }

    function settleCatRaceBet(uint256 raceId) external returns (uint256 payout) {
        require(raceId > 0 && raceId < currentCatRaceId(), "race active");
        require(!catRaceClaimed[raceId][msg.sender], "already claimed");
        catRaceClaimed[raceId][msg.sender] = true;

        uint8 winnerCat = _catRaceWinner(raceId);
        uint256 winningBet = catRacePlayerBets[raceId][msg.sender][winnerCat];
        if (winningBet > 0) {
            uint256 grossPayout = winningBet * 5;
            uint256 winFee = (grossPayout * winFeeBps) / 10_000;
            payout = grossPayout - winFee;
            require(poolLiquidity() >= payout, "pool too low");
            playerBalances[msg.sender] += payout;
            totalPlayerBalances += payout;
            catRaceWonTotals[msg.sender] += payout;
            _sortCatRaceLeaderboard(msg.sender);
        }

        emit CatRaceSettled(raceId, msg.sender, winnerCat, payout);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "zero owner");
        emit OwnerChanged(owner, nextOwner);
        owner = nextOwner;
    }

    function setTrustedRelayer(address relayer, bool trusted) external onlyOwner {
        require(relayer != address(0), "zero relayer");
        trustedRelayers[relayer] = trusted;
        emit TrustedRelayerUpdated(relayer, trusted);
    }

    function setFees(uint16 nextEntryFeeBps, uint16 nextWinFeeBps) external onlyOwner {
        require(nextEntryFeeBps <= 2_000 && nextWinFeeBps <= 2_000, "fee too high");
        entryFeeBps = nextEntryFeeBps;
        winFeeBps = nextWinFeeBps;
        emit FeesUpdated(nextEntryFeeBps, nextWinFeeBps);
    }

    function setBetLimits(uint256 nextMinBet, uint256 nextMaxBet) external onlyOwner {
        require(nextMinBet > 0 && nextMinBet <= nextMaxBet, "invalid limits");
        minBet = nextMinBet;
        maxBet = nextMaxBet;
        emit BetLimitsUpdated(nextMinBet, nextMaxBet);
    }

    function depositPool() external payable onlyOwner {
        require(msg.value > 0, "zero deposit");
        emit PoolDeposited(msg.sender, msg.value);
    }

    function withdrawPool(uint256 amount, address payable to) external onlyOwner {
        require(to != address(0), "zero recipient");
        require(amount <= poolLiquidity(), "insufficient pool");
        (bool sent, ) = to.call{value: amount}("");
        require(sent, "withdraw failed");
        emit PoolWithdrawn(to, amount);
    }

    function depositPlayer() external payable {
        require(msg.value > 0, "zero deposit");
        playerBalances[msg.sender] += msg.value;
        totalPlayerBalances += msg.value;
        emit PlayerDeposited(msg.sender, msg.value, playerBalances[msg.sender]);
    }

    function withdrawPlayer(uint256 amount) external {
        require(amount > 0, "zero withdraw");
        require(playerBalances[msg.sender] >= amount, "insufficient balance");
        playerBalances[msg.sender] -= amount;
        totalPlayerBalances -= amount;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "withdraw failed");
        emit PlayerWithdrawn(msg.sender, amount, playerBalances[msg.sender]);
    }

    function commitServerSeed(bytes32 serverSeedHash) external onlyTrustedRelayer {
        require(serverSeedHash != bytes32(0), "zero seed hash");
        require(!serverSeedCommitments[serverSeedHash], "seed already committed");
        serverSeedCommitments[serverSeedHash] = true;
        emit ServerSeedCommitted(serverSeedHash, msg.sender);
    }

    function playRelayed(RelayedPlay calldata play) external onlyTrustedRelayer returns (uint256 roundId) {
        require(play.player != address(0), "zero player");
        require(play.playerSeed != bytes32(0), "zero player seed");
        require(play.nextServerSeedHash != bytes32(0), "zero next seed");
        require(play.sessionExpiresAt >= block.timestamp, "session expired");
        require(play.gameType <= uint8(GameType.Rps), "invalid game");
        require(_isValidMove(play.gameType, play.playerMove), "invalid move");

        bytes32 activeServerSeedHash = keccak256(abi.encodePacked(play.serverSeed));
        require(serverSeedCommitments[activeServerSeedHash], "seed not committed");

        bytes32 activeSessionHash = sessionHash(play.player, msg.sender, play.sessionAllowance, play.sessionExpiresAt, play.sessionNonce);
        address signer = _recover(sessionDigest(play.player, msg.sender, play.sessionAllowance, play.sessionExpiresAt, play.sessionNonce), play.sessionSignature);
        require(signer == play.player, "invalid session signature");
        require(sessionSpent[activeSessionHash] + play.betAmount <= play.sessionAllowance, "session allowance");

        sessionSpent[activeSessionHash] += play.betAmount;
        serverSeedCommitments[activeServerSeedHash] = false;
        require(!serverSeedCommitments[play.nextServerSeedHash], "next seed exists");
        serverSeedCommitments[play.nextServerSeedHash] = true;

        _chargePlayer(play.player, play.betAmount);

        uint8 outcome = _outcome(play.gameType, play.player, play.playerMove, play.playerSeed, play.serverSeed);
        Result result = play.gameType == uint8(GameType.CoinFlip)
            ? (play.playerMove == outcome ? Result.Win : Result.Lose)
            : _rpsResult(play.playerMove, outcome);

        roundId = _settleBalance(
            GameType(play.gameType),
            play.player,
            play.betAmount,
            play.playerMove,
            outcome,
            result,
            play.playerSeed,
            activeServerSeedHash
        );

        emit ServerSeedRevealed(activeServerSeedHash, play.nextServerSeedHash, msg.sender);
    }

    function playDirect(uint8 gameType, uint8 playerMove, uint256 betAmount, bytes32 playerSeed) external returns (uint256 roundId) {
        require(playerSeed != bytes32(0), "zero player seed");
        require(gameType <= uint8(GameType.Rps), "invalid game");
        require(_isValidMove(gameType, playerMove), "invalid move");

        _chargePlayer(msg.sender, betAmount);

        bytes32 directSeed = keccak256(
            abi.encodePacked(
                playerSeed,
                msg.sender,
                blockhash(block.number - 1),
                block.prevrandao,
                block.timestamp,
                block.coinbase,
                nextRoundId,
                address(this),
                block.chainid
            )
        );

        uint8 outcome = _outcome(gameType, msg.sender, playerMove, playerSeed, directSeed);
        Result result = gameType == uint8(GameType.CoinFlip)
            ? (playerMove == outcome ? Result.Win : Result.Lose)
            : _rpsResult(playerMove, outcome);

        roundId = _settleBalance(
            GameType(gameType),
            msg.sender,
            betAmount,
            playerMove,
            outcome,
            result,
            playerSeed,
            keccak256(abi.encodePacked(directSeed))
        );
    }

    function _validateBet(uint256 betAmount) private view {
        require(betAmount >= minBet && betAmount <= maxBet, "bet out of range");
    }

    function _chargePlayer(address player, uint256 betAmount) private {
        _validateBet(betAmount);
        uint256 entryFee = (betAmount * entryFeeBps) / 10_000;
        uint256 totalCost = betAmount + entryFee;
        require(playerBalances[player] >= totalCost, "insufficient game balance");
        playerBalances[player] -= totalCost;
        totalPlayerBalances -= totalCost;
    }

    function _settleBalance(
        GameType gameType,
        address player,
        uint256 betAmount,
        uint8 playerMove,
        uint8 outcome,
        Result result,
        bytes32 playerSeed,
        bytes32 serverSeedHash
    ) private returns (uint256 roundId) {
        (uint256 payout, uint256 entryFee, uint256 winFee) = _calculatePayout(betAmount, result);
        if (payout > 0) {
            require(poolLiquidity() >= payout, "pool too low");
            playerBalances[player] += payout;
            totalPlayerBalances += payout;
        }

        _recordLeaderboardProfit(player, payout, betAmount);

        roundId = nextRoundId++;
        rounds[roundId] = Round({
            player: player,
            gameType: gameType,
            betAmount: betAmount,
            playerMove: playerMove,
            outcome: outcome,
            result: result,
            payout: payout,
            entryFee: entryFee,
            winFee: winFee
        });

        emit RoundSettled(
            roundId,
            player,
            uint8(gameType),
            betAmount,
            playerMove,
            outcome,
            uint8(result),
            payout
        );
        emit RoundRandomness(roundId, playerSeed, serverSeedHash);
    }

    function _recordLeaderboardProfit(address player, uint256 payout, uint256 betAmount) private {
        uint256 epoch = currentLeaderboardEpoch();
        epochPlayCount[epoch][player] += 1;
        int256 delta = int256(payout) - int256(betAmount);
        int256 nextProfit = epochNetProfit[epoch][player] + delta;
        epochNetProfit[epoch][player] = nextProfit;

        address[10] storage players = epochTopPlayers[epoch];
        uint256 index = 10;
        for (uint256 i = 0; i < 10; i++) {
            if (players[i] == player) {
                index = i;
                break;
            }
        }

        if (nextProfit <= 0) {
            if (index < 10) {
                players[index] = address(0);
                _sortLeaderboard(epoch);
            }
            emit LeaderboardUpdated(epoch, player, nextProfit);
            return;
        }

        if (index == 10) {
            address lastPlayer = players[9];
            if (lastPlayer == address(0) || nextProfit > epochNetProfit[epoch][lastPlayer]) {
                players[9] = player;
            } else {
                emit LeaderboardUpdated(epoch, player, nextProfit);
                return;
            }
        }

        _sortLeaderboard(epoch);
        emit LeaderboardUpdated(epoch, player, nextProfit);
    }

    function _sortLeaderboard(uint256 epoch) private {
        address[10] storage players = epochTopPlayers[epoch];
        for (uint256 i = 0; i < 10; i++) {
            for (uint256 j = i + 1; j < 10; j++) {
                if (_leaderboardComesBefore(epoch, players[j], players[i])) {
                    address temp = players[i];
                    players[i] = players[j];
                    players[j] = temp;
                }
            }
        }
    }

    function _leaderboardComesBefore(uint256 epoch, address candidate, address current) private view returns (bool) {
        if (candidate == address(0)) {
            return false;
        }
        if (current == address(0)) {
            return true;
        }
        return epochNetProfit[epoch][candidate] > epochNetProfit[epoch][current];
    }

    function _isLeaderboardRewardEligible(uint256 epoch, address player) private view returns (bool) {
        return player != address(0) && epochNetProfit[epoch][player] > 0 && epochPlayCount[epoch][player] >= MIN_LEADERBOARD_GAMES;
    }

    function _leaderboardReward(uint8 index) private view returns (uint256) {
        return leaderboardRewardAmounts[index];
    }

    function _catRaceCycleDuration() private view returns (uint256) {
        return catRacePrepareDuration + catRaceRunDuration;
    }

    function _catRaceWinner(uint256 raceId) private view returns (uint8) {
        (, uint256 bettingEndsAt, ) = catRaceRoundBounds(raceId);
        return uint8(uint256(keccak256(abi.encodePacked(raceId, bettingEndsAt, address(this), block.chainid))) % 5);
    }

    function _sortCatRaceLeaderboard(address player) private {
        address[10] storage players = catRaceTopPlayers;
        uint256 index = 10;
        for (uint256 i = 0; i < 10; i++) {
            if (players[i] == player) {
                index = i;
                break;
            }
        }

        if (index == 10) {
            address lastPlayer = players[9];
            if (lastPlayer == address(0) || catRaceWonTotals[player] > catRaceWonTotals[lastPlayer]) {
                players[9] = player;
            } else {
                return;
            }
        }

        for (uint256 i = 0; i < 10; i++) {
            for (uint256 j = i + 1; j < 10; j++) {
                if (_catRaceComesBefore(players[j], players[i])) {
                    address temp = players[i];
                    players[i] = players[j];
                    players[j] = temp;
                }
            }
        }
    }

    function _catRaceComesBefore(address candidate, address current) private view returns (bool) {
        if (candidate == address(0)) {
            return false;
        }
        if (current == address(0)) {
            return true;
        }
        return catRaceWonTotals[candidate] > catRaceWonTotals[current];
    }

    function _calculatePayout(uint256 betAmount, Result result) private view returns (uint256 payout, uint256 entryFee, uint256 winFee) {
        entryFee = (betAmount * entryFeeBps) / 10_000;
        if (result == Result.Win) {
            uint256 grossPayout = betAmount * 2;
            winFee = (grossPayout * winFeeBps) / 10_000;
            payout = grossPayout - winFee;
        } else if (result == Result.Draw) {
            payout = betAmount;
        }
    }

    function _outcome(
        uint8 gameType,
        address player,
        uint8 playerMove,
        bytes32 playerSeed,
        bytes32 serverSeed
    ) private view returns (uint8) {
        uint256 randomValue = uint256(
            keccak256(
                abi.encodePacked(
                    serverSeed,
                    playerSeed,
                    player,
                    playerMove,
                    nextRoundId,
                    address(this),
                    block.chainid
                )
            )
        );
        return uint8(randomValue % (gameType == uint8(GameType.CoinFlip) ? 2 : 3));
    }

    function _isValidMove(uint8 gameType, uint8 playerMove) private pure returns (bool) {
        if (gameType == uint8(GameType.CoinFlip)) {
            return playerMove < 2;
        }
        return playerMove < 3;
    }

    function _rpsResult(uint8 move, uint8 outcome) private pure returns (Result) {
        if (move == outcome) {
            return Result.Draw;
        }
        return (move + 1) % 3 == outcome ? Result.Win : Result.Lose;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "bad signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "bad signature v");
        return ecrecover(digest, v, r, s);
    }
}
