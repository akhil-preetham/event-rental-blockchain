// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRentalEscrow {
    function fundDeposit(uint256 rentalId) external payable;
    function markReturned(uint256 rentalId) external;
    function withdraw() external;
}

contract RejectingReceiver {
    function fundDeposit(address escrow, uint256 rentalId) external payable {
        IRentalEscrow(escrow).fundDeposit{value: msg.value}(rentalId);
    }

    function markReturned(address escrow, uint256 rentalId) external {
        IRentalEscrow(escrow).markReturned(rentalId);
    }

    function withdraw(address escrow) external {
        IRentalEscrow(escrow).withdraw();
    }

    receive() external payable {
        revert();
    }
}
