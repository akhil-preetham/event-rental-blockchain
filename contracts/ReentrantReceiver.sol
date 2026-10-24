// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IReentrantEscrow {
    function fundDeposit(uint256 rentalId) external payable;
    function markReturned(uint256 rentalId) external;
    function withdraw() external;
}

contract ReentrantReceiver {
    bool public reentrantAttemptBlocked;

    function fundDeposit(address escrow, uint256 rentalId) external payable {
        IReentrantEscrow(escrow).fundDeposit{value: msg.value}(rentalId);
    }

    function markReturned(address escrow, uint256 rentalId) external {
        IReentrantEscrow(escrow).markReturned(rentalId);
    }

    function attack(address escrow) external {
        IReentrantEscrow(escrow).withdraw();
    }

    receive() external payable {
        try IReentrantEscrow(msg.sender).withdraw() {
            revert();
        } catch {
            reentrantAttemptBlocked = true;
        }
    }
}
