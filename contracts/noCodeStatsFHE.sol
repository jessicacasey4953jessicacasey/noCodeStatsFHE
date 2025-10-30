pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NoCodeStatsFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60; // Default cooldown: 60 seconds

    bool public paused = false;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 dataCount;
    }

    uint256 public currentBatchId = 1;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => euint32[]) public encryptedData; // batchId => array of euint32

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 count);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 result);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                emit ContractPaused(msg.sender);
            } else {
                emit ContractUnpaused(msg.sender);
            }
        }
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSecondsChanged(oldCooldown, newCooldown);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batches[currentBatchId] = Batch({id: currentBatchId, isOpen: true, dataCount: 0});
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) revert InvalidBatch();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitData(uint256 batchId, euint32[] calldata dataPoints) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) revert BatchClosed();

        _initIfNeeded();

        for (uint i = 0; i < dataPoints.length; i++) {
            encryptedData[batchId].push(dataPoints[i]);
        }
        batches[batchId].dataCount += dataPoints.length;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, batchId, dataPoints.length);
    }

    function requestMeanCalculation(uint256 batchId) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        if (batches[batchId].dataCount == 0) revert NoData(); // Custom error for this case

        _initIfNeeded();

        euint32[] storage data = encryptedData[batchId];
        euint32 sum = FHE.asEuint32(0);

        for (uint i = 0; i < data.length; i++) {
            sum = sum.add(data[i]);
        }

        euint32 countEnc = FHE.asEuint32(data.length);
        euint32 meanEnc = sum.mul(FHE.asEuint32(1).add(countEnc).sub(FHE.asEuint32(1)).inv()); // mean = sum / count

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = meanEnc.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // @dev Replay protection: ensure this callback is processed only once.
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // @dev State verification: Rebuild the ciphertexts array from current contract storage
        // in the exact same order as when requestDecryption was called.
        // This ensures the contract state relevant to the computation has not changed.
        DecryptionContext memory context = decryptionContexts[requestId];
        euint32[] storage data = encryptedData[context.batchId];
        euint32 sum = FHE.asEuint32(0);

        for (uint i = 0; i < data.length; i++) {
            sum = sum.add(data[i]);
        }
        euint32 countEnc = FHE.asEuint32(data.length);
        euint32 meanEnc = sum.mul(FHE.asEuint32(1).add(countEnc).sub(FHE.asEuint32(1)).inv());

        bytes32[] memory currentCts = new bytes32[](1);
        currentCts[0] = meanEnc.toBytes32();
        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != context.stateHash) revert StateMismatch();
        // @dev End state verification

        // @dev Proof verification: Ensure the cleartexts and proof are valid for the requestId.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();
        // @dev End proof verification

        // Decode cleartexts
        uint256 mean = abi.decode(cleartexts, (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, context.batchId, mean);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded() internal {
        if (!FHE.isInitialized()) {
            FHE.initialize();
        }
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) revert NotInitialized();
    }
}