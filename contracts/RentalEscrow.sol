// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract RentalEscrow is ReentrancyGuard {
    enum Status {
        CREATED,
        FUNDED,
        ACTIVE,
        RETURNED,
        REFUNDED,
        DISPUTED,
        RESOLVED
    }

    struct Rental {
        uint256 id;
        string equipmentId;
        string equipmentName;
        address owner;
        address renter;
        uint256 rentalFee;
        uint256 deposit;
        uint256 startTime;
        uint256 endTime;
        Status status;
    }

    uint256 private nextRentalId = 1;
    mapping(uint256 => Rental) private rentals;

    error InvalidRenter();
    error InvalidRentalFee();
    error InvalidDeposit();
    error InvalidTimeRange();
    error UnauthorizedRenter();
    error UnauthorizedOwner();
    error InvalidRentalStatus();
    error IncorrectDepositAmount();
    error TransferFailed();
    error InvalidArbitrator();
    error UnauthorizedArbitrator();
    error UnauthorizedDisputeParty();
    error InvalidDisputeAmounts();
    error RentalNotFound();
    error UnauthorizedTimeoutParty();
    error RentalNotEnded();
    error NoClaimableBalance();
    error RentalNotStarted();
    error InvalidEquipmentIdentifier();
    error EquipmentUnavailable();

    address public immutable arbitrator;
    mapping(address => uint256) public claimable;
    mapping(bytes32 => uint256[]) public equipmentRentals;

    constructor(address arbitratorAddress) {
        if (arbitratorAddress == address(0)) revert InvalidArbitrator();
        arbitrator = arbitratorAddress;
    }

    event RentalCreated(
        uint256 indexed rentalId,
        address indexed owner,
        address indexed renter
    );
    event DepositFunded(
        uint256 indexed rentalId,
        address indexed renter,
        uint256 amount
    );
    event PickupConfirmed(uint256 indexed rentalId, address indexed owner);
    event EquipmentReturned(uint256 indexed rentalId, address indexed renter);
    event RefundIssued(
        uint256 indexed rentalId,
        address indexed renter,
        uint256 amount
    );
    event DisputeRaised(uint256 indexed rentalId, address indexed raisedBy);
    event DisputeResolved(
        uint256 indexed rentalId,
        uint256 renterAmount,
        uint256 ownerAmount
    );
    event RentalTimedOut(uint256 indexed rentalId, address indexed triggeredBy);
    event ClaimWithdrawn(address indexed recipient, uint256 amount);
    event RentalRecovered(
        uint256 indexed rentalId,
        address indexed renter,
        uint256 amount
    );

    function createRental(
        string calldata equipmentId,
        string calldata equipmentName,
        address renter,
        uint256 rentalFee,
        uint256 deposit,
        uint256 startTime,
        uint256 endTime
    ) external returns (uint256 rentalId) {
        if (bytes(equipmentId).length == 0) revert InvalidEquipmentIdentifier();
        if (renter == address(0)) revert InvalidRenter();
        if (rentalFee == 0) revert InvalidRentalFee();
        if (deposit == 0) revert InvalidDeposit();
        if (endTime <= startTime) revert InvalidTimeRange();

        rentalId = nextRentalId++;
        rentals[rentalId] = Rental({
            id: rentalId,
            equipmentId: equipmentId,
            equipmentName: equipmentName,
            owner: msg.sender,
            renter: renter,
            rentalFee: rentalFee,
            deposit: deposit,
            startTime: startTime,
            endTime: endTime,
            status: Status.CREATED
        });
        equipmentRentals[_equipmentKey(equipmentId)].push(rentalId);

        emit RentalCreated(rentalId, msg.sender, renter);
    }

    function getRental(uint256 rentalId) external view returns (Rental memory) {
        return rentals[rentalId];
    }

    function fundDeposit(uint256 rentalId) external payable {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != rental.renter) revert UnauthorizedRenter();
        if (rental.status != Status.CREATED) revert InvalidRentalStatus();
        if (msg.value != rental.deposit) revert IncorrectDepositAmount();
        if (_hasOverlappingReservation(rental)) revert EquipmentUnavailable();

        rental.status = Status.FUNDED;

        emit DepositFunded(rentalId, msg.sender, msg.value);
    }

    function _equipmentKey(string memory equipmentId) internal pure returns (bytes32) {
        return keccak256(bytes(equipmentId));
    }

    function _hasOverlappingReservation(Rental storage candidate) internal view returns (bool) {
        uint256[] storage rentalIds = equipmentRentals[_equipmentKey(candidate.equipmentId)];
        for (uint256 index = 0; index < rentalIds.length; index++) {
            Rental storage existing = rentals[rentalIds[index]];
            if (existing.id == candidate.id) continue;
            if (
                (existing.status == Status.FUNDED || existing.status == Status.ACTIVE) &&
                candidate.startTime < existing.endTime &&
                candidate.endTime > existing.startTime
            ) {
                return true;
            }
        }
        return false;
    }

    function recoverUnconfirmedRental(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];

        if (rental.id == 0) revert RentalNotFound();
        if (msg.sender != rental.renter) revert UnauthorizedRenter();
        if (rental.status != Status.FUNDED) revert InvalidRentalStatus();
        if (block.timestamp < rental.startTime) revert RentalNotStarted();

        rental.status = Status.REFUNDED;
        claimable[rental.renter] += rental.deposit;

        emit RentalRecovered(rentalId, rental.renter, rental.deposit);
    }

    function confirmPickup(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != rental.owner) revert UnauthorizedOwner();
        if (rental.status != Status.FUNDED) revert InvalidRentalStatus();

        rental.status = Status.ACTIVE;

        emit PickupConfirmed(rentalId, msg.sender);
    }

    function markReturned(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != rental.renter) revert UnauthorizedRenter();
        if (rental.status != Status.ACTIVE) revert InvalidRentalStatus();

        rental.status = Status.RETURNED;

        emit EquipmentReturned(rentalId, msg.sender);
    }

    function approveRefund(uint256 rentalId) external nonReentrant {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != rental.owner) revert UnauthorizedOwner();
        if (rental.status != Status.RETURNED) revert InvalidRentalStatus();

        rental.status = Status.REFUNDED;
        claimable[rental.renter] += rental.deposit;

        emit RefundIssued(rentalId, rental.renter, rental.deposit);
    }

    function raiseDispute(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != rental.owner && msg.sender != rental.renter) {
            revert UnauthorizedDisputeParty();
        }
        if (rental.status != Status.RETURNED) revert InvalidRentalStatus();

        rental.status = Status.DISPUTED;

        emit DisputeRaised(rentalId, msg.sender);
    }

    function resolveDispute(
        uint256 rentalId,
        uint256 renterAmount,
        uint256 ownerAmount
    ) external nonReentrant {
        Rental storage rental = rentals[rentalId];

        if (msg.sender != arbitrator) revert UnauthorizedArbitrator();
        if (rental.status != Status.DISPUTED) revert InvalidRentalStatus();
        if (renterAmount + ownerAmount != rental.deposit) {
            revert InvalidDisputeAmounts();
        }

        rental.status = Status.RESOLVED;
        claimable[rental.renter] += renterAmount;
        claimable[rental.owner] += ownerAmount;

        emit DisputeResolved(rentalId, renterAmount, ownerAmount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NoClaimableBalance();

        claimable[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit ClaimWithdrawn(msg.sender, amount);
    }

    function triggerTimeout(uint256 rentalId) external {
        Rental storage rental = rentals[rentalId];

        if (rental.id == 0) revert RentalNotFound();
        if (msg.sender != rental.owner && msg.sender != rental.renter) {
            revert UnauthorizedTimeoutParty();
        }
        if (rental.status != Status.ACTIVE) revert InvalidRentalStatus();
        if (block.timestamp < rental.endTime) revert RentalNotEnded();

        rental.status = Status.DISPUTED;

        emit RentalTimedOut(rentalId, msg.sender);
    }
}
