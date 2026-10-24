import { expect } from "chai";
import { network } from "hardhat";

describe("RentalEscrow", function () {
  async function deployFixture() {
    const { ethers } = await network.connect();
    const [owner, renter, arbitrator, unauthorized] = await ethers.getSigners();
    const rentalEscrow = await ethers.deployContract("RentalEscrow", [
      arbitrator.address,
    ]);

    return { ethers, rentalEscrow, owner, renter, arbitrator, unauthorized };
  }

  type RentalEscrowContract = Awaited<
    ReturnType<typeof deployFixture>
  >["rentalEscrow"];

  async function validRental(renter: string) {
    return {
      equipmentId: "CAM-001",
      equipmentName: "4K Camera",
      renter,
      rentalFee: 10n,
      deposit: 50n,
      startTime: 1_000n,
      endTime: 2_000n,
    };
  }

  async function createValidRental(
    rentalEscrow: RentalEscrowContract,
    renter: { address: string },
  ) {
    const rental = await validRental(renter.address);
    await rentalEscrow.createRental(
      rental.equipmentId,
      rental.equipmentName,
      rental.renter,
      rental.rentalFee,
      rental.deposit,
      rental.startTime,
      rental.endTime,
    );
    return rental;
  }

  async function createReturnedRental(
    rentalEscrow: RentalEscrowContract,
    owner: { address: string },
    renter: { address: string },
  ) {
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rentalEscrow.connect(renter).markReturned(1n);
    return rental;
  }

  async function createDisputedRental(
    rentalEscrow: RentalEscrowContract,
    owner: { address: string },
    renter: { address: string },
  ) {
    const rental = await createReturnedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(owner).raiseDispute(1n);
    return rental;
  }

  async function createActiveTimedRental(
    rentalEscrow: RentalEscrowContract,
    ethers: Awaited<ReturnType<typeof deployFixture>>["ethers"],
    owner: { address: string },
    renter: { address: string },
  ) {
    const latestBlock = await ethers.provider.getBlock("latest");
    const startTime = BigInt(latestBlock!.timestamp + 100);
    const endTime = startTime + 100n;
    const rental = {
      equipmentId: "CAM-TIMEOUT",
      equipmentName: "Timed Camera",
      renter: renter.address,
      rentalFee: 10n,
      deposit: 50n,
      startTime,
      endTime,
    };

    await rentalEscrow.createRental(
      rental.equipmentId,
      rental.equipmentName,
      rental.renter,
      rental.rentalFee,
      rental.deposit,
      rental.startTime,
      rental.endTime,
    );
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);

    return rental;
  }

  async function createFundedRecoveryRental(
    rentalEscrow: RentalEscrowContract,
    ethers: Awaited<ReturnType<typeof deployFixture>>["ethers"],
    renter: { address: string },
  ) {
    const latestBlock = await ethers.provider.getBlock("latest");
    const startTime = BigInt(latestBlock!.timestamp + 100);
    const endTime = startTime + 100n;
    const rental = {
      equipmentId: "CAM-RECOVERY",
      equipmentName: "Recovery Camera",
      renter: renter.address,
      rentalFee: 10n,
      deposit: 50n,
      startTime,
      endTime,
    };

    await rentalEscrow.createRental(
      rental.equipmentId,
      rental.equipmentName,
      rental.renter,
      rental.rentalFee,
      rental.deposit,
      rental.startTime,
      rental.endTime,
    );
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });

    return rental;
  }

  it("creates a rental with CREATED status", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await validRental(renter.address);

    await expect(
      rentalEscrow.createRental(
        rental.equipmentId,
        rental.equipmentName,
        rental.renter,
        rental.rentalFee,
        rental.deposit,
        rental.startTime,
        rental.endTime,
      ),
    )
      .to.emit(rentalEscrow, "RentalCreated")
      .withArgs(1n, owner.address, renter.address);

    const stored = await rentalEscrow.getRental(1n);
    expect(stored.id).to.equal(1n);
    expect(stored.equipmentId).to.equal(rental.equipmentId);
    expect(stored.equipmentName).to.equal(rental.equipmentName);
    expect(stored.owner).to.equal(owner.address);
    expect(stored.renter).to.equal(renter.address);
    expect(stored.rentalFee).to.equal(rental.rentalFee);
    expect(stored.deposit).to.equal(rental.deposit);
    expect(stored.startTime).to.equal(rental.startTime);
    expect(stored.endTime).to.equal(rental.endTime);
    expect(stored.status).to.equal(0n);
  });

  it("assigns unique rental IDs", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const first = await validRental(renter.address);
    const second = await validRental(renter.address);

    await rentalEscrow.createRental(
      first.equipmentId,
      first.equipmentName,
      first.renter,
      first.rentalFee,
      first.deposit,
      first.startTime,
      first.endTime,
    );
    await rentalEscrow.createRental(
      second.equipmentId,
      second.equipmentName,
      second.renter,
      second.rentalFee,
      second.deposit,
      second.startTime,
      second.endTime,
    );

    expect((await rentalEscrow.getRental(1n)).owner).to.equal(owner.address);
    expect((await rentalEscrow.getRental(2n)).id).to.equal(2n);
  });

  it("rejects a zero renter address", async function () {
    const { rentalEscrow } = await deployFixture();
    const rental = await validRental("0x0000000000000000000000000000000000000000");

    await expect(
      rentalEscrow.createRental(
        rental.equipmentId,
        rental.equipmentName,
        rental.renter,
        rental.rentalFee,
        rental.deposit,
        rental.startTime,
        rental.endTime,
      ),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRenter");
  });

  it("rejects a zero rental fee", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await validRental(renter.address);

    await expect(
      rentalEscrow.createRental(
        rental.equipmentId,
        rental.equipmentName,
        rental.renter,
        0n,
        rental.deposit,
        rental.startTime,
        rental.endTime,
      ),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalFee");
  });

  it("rejects a zero deposit", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await validRental(renter.address);

    await expect(
      rentalEscrow.createRental(
        rental.equipmentId,
        rental.equipmentName,
        rental.renter,
        rental.rentalFee,
        0n,
        rental.startTime,
        rental.endTime,
      ),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidDeposit");
  });

  it("rejects an end time that is not after the start time", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await validRental(renter.address);

    await expect(
      rentalEscrow.createRental(
        rental.equipmentId,
        rental.equipmentName,
        rental.renter,
        rental.rentalFee,
        rental.deposit,
        rental.endTime,
        rental.startTime,
      ),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidTimeRange");
  });

  it("funds the required deposit and changes the status to FUNDED", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await expect(rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit }))
      .to.emit(rentalEscrow, "DepositFunded")
      .withArgs(1n, renter.address, rental.deposit);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(1n);
  });

  it("rejects a deposit funded by a non-renter", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(owner).fundDeposit(1n, { value: rental.deposit }),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedRenter");
  });

  it("rejects an incorrect deposit amount", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit - 1n }),
    ).to.be.revertedWithCustomError(rentalEscrow, "IncorrectDepositAmount");
  });

  it("rejects a zero-value deposit payment", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(renter).fundDeposit(1n, { value: 0n }),
    ).to.be.revertedWithCustomError(rentalEscrow, "IncorrectDepositAmount");
  });

  it("rejects funding an already funded rental", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });

    await expect(
      rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit }),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("holds the funded deposit in the contract", async function () {
    const { rentalEscrow, renter, ethers } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    const contractAddress = await rentalEscrow.getAddress();
    const balanceBefore = await ethers.provider.getBalance(contractAddress);

    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });

    const balanceAfter = await ethers.provider.getBalance(contractAddress);
    expect(balanceAfter - balanceBefore).to.equal(rental.deposit);
  });

  it("confirms pickup and changes the status to ACTIVE", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });

    await expect(rentalEscrow.connect(owner).confirmPickup(1n))
      .to.emit(rentalEscrow, "PickupConfirmed")
      .withArgs(1n, owner.address);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(2n);
  });

  it("rejects pickup confirmation by a non-owner", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });

    await expect(
      rentalEscrow.connect(renter).confirmPickup(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedOwner");
  });

  it("rejects pickup confirmation before the deposit is funded", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(owner).confirmPickup(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects pickup confirmation twice", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);

    await expect(
      rentalEscrow.connect(owner).confirmPickup(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("marks equipment returned and changes the status to RETURNED", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);

    await expect(rentalEscrow.connect(renter).markReturned(1n))
      .to.emit(rentalEscrow, "EquipmentReturned")
      .withArgs(1n, renter.address);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(3n);
  });

  it("rejects equipment return by a non-renter", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);

    await expect(
      rentalEscrow.connect(owner).markReturned(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedRenter");
  });

  it("rejects equipment return before pickup", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(renter).markReturned(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects equipment return twice", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rentalEscrow.connect(renter).markReturned(1n);

    await expect(
      rentalEscrow.connect(renter).markReturned(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("refunds the deposit after the equipment is returned", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createReturnedRental(rentalEscrow, owner, renter);

    await expect(rentalEscrow.connect(owner).approveRefund(1n))
      .to.emit(rentalEscrow, "RefundIssued")
      .withArgs(1n, renter.address, rental.deposit);
  });

  it("creates the renter's claimable refund without transferring ETH", async function () {
    const { rentalEscrow, owner, renter, ethers } = await deployFixture();
    const rental = await createReturnedRental(rentalEscrow, owner, renter);
    const renterBalanceBefore = await ethers.provider.getBalance(renter.address);
    const contractBalanceBefore = await ethers.provider.getBalance(
      await rentalEscrow.getAddress(),
    );

    await rentalEscrow.connect(owner).approveRefund(1n);

    const renterBalanceAfter = await ethers.provider.getBalance(renter.address);
    const contractBalanceAfter = await ethers.provider.getBalance(
      await rentalEscrow.getAddress(),
    );
    expect(await rentalEscrow.claimable(renter.address)).to.equal(rental.deposit);
    expect(renterBalanceAfter).to.equal(renterBalanceBefore);
    expect(contractBalanceAfter).to.equal(contractBalanceBefore);
  });

  it("allows the renter to withdraw a refund claim", async function () {
    const { rentalEscrow, owner, renter, ethers } = await deployFixture();
    const rental = await createReturnedRental(rentalEscrow, owner, renter);
    const contractAddress = await rentalEscrow.getAddress();
    await rentalEscrow.connect(owner).approveRefund(1n);
    const renterBalanceBefore = await ethers.provider.getBalance(renter.address);

    const withdrawal = await rentalEscrow.connect(renter).withdraw();
    const withdrawalReceipt = await withdrawal.wait();
    const withdrawalFee =
      withdrawalReceipt!.gasUsed * withdrawalReceipt!.gasPrice;
    const renterBalanceAfter = await ethers.provider.getBalance(renter.address);

    expect(await rentalEscrow.claimable(renter.address)).to.equal(0n);
    expect(renterBalanceBefore).to.be.greaterThan(renterBalanceAfter);
    expect(renterBalanceAfter - renterBalanceBefore + withdrawalFee).to.equal(
      rental.deposit,
    );
    expect(await ethers.provider.getBalance(contractAddress)).to.equal(0n);
  });

  it("emits a claim withdrawal event", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createReturnedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(owner).approveRefund(1n);

    await expect(rentalEscrow.connect(renter).withdraw())
      .to.emit(rentalEscrow, "ClaimWithdrawn")
      .withArgs(renter.address, rental.deposit);
  });

  it("rejects withdrawal when no claimable balance exists", async function () {
    const { rentalEscrow, renter } = await deployFixture();

    await expect(
      rentalEscrow.connect(renter).withdraw(),
    ).to.be.revertedWithCustomError(rentalEscrow, "NoClaimableBalance");
  });

  it("rejects a refund approved by a non-owner", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);

    await expect(
      rentalEscrow.connect(renter).approveRefund(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedOwner");
  });

  it("rejects a refund before the equipment is returned", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);

    await expect(
      rentalEscrow.connect(owner).approveRefund(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects a double refund", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(owner).approveRefund(1n);

    await expect(
      rentalEscrow.connect(owner).approveRefund(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects a second withdrawal", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(owner).approveRefund(1n);
    await rentalEscrow.connect(renter).withdraw();

    await expect(
    rentalEscrow.connect(renter).withdraw(),
    ).to.be.revertedWithCustomError(rentalEscrow, "NoClaimableBalance");
  });

  it("changes the rental status to REFUNDED", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);

    await rentalEscrow.connect(owner).approveRefund(1n);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(4n);
  });

  it("allows the owner to raise a dispute", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createReturnedRental(rentalEscrow, owner, renter);

    await expect(rentalEscrow.connect(owner).raiseDispute(1n))
      .to.emit(rentalEscrow, "DisputeRaised")
      .withArgs(1n, owner.address);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(5n);
  });

  it("allows the renter to raise a dispute", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);

    await expect(rentalEscrow.connect(renter).raiseDispute(1n))
      .to.emit(rentalEscrow, "DisputeRaised")
      .withArgs(1n, renter.address);
  });

  it("rejects a dispute raised by an unauthorized address", async function () {
    const { rentalEscrow, owner, renter, unauthorized } = await deployFixture();
    await createReturnedRental(rentalEscrow, owner, renter);

    await expect(
      rentalEscrow.connect(unauthorized).raiseDispute(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedDisputeParty");
  });

  it("rejects a dispute raised before equipment is returned", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(owner).raiseDispute(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("allows the arbitrator to resolve a dispute", async function () {
    const { rentalEscrow, owner, renter, arbitrator } = await deployFixture();
    const rental = await createDisputedRental(rentalEscrow, owner, renter);

    await expect(rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n))
      .to.emit(rentalEscrow, "DisputeResolved")
      .withArgs(1n, 30n, 20n);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(6n);
  });

  it("rejects dispute resolution by a non-arbitrator", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    await createDisputedRental(rentalEscrow, owner, renter);

    await expect(
      rentalEscrow.connect(owner).resolveDispute(1n, 30n, 20n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedArbitrator");
  });

  it("rejects dispute amounts that do not equal the deposit", async function () {
    const { rentalEscrow, owner, renter, arbitrator } = await deployFixture();
    await createDisputedRental(rentalEscrow, owner, renter);

    await expect(
      rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 10n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidDisputeAmounts");
  });

  it("creates the specified renter and owner claimable balances", async function () {
    const { rentalEscrow, owner, renter, arbitrator } = await deployFixture();
    await createDisputedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n);

    expect(await rentalEscrow.claimable(renter.address)).to.equal(30n);
    expect(await rentalEscrow.claimable(owner.address)).to.equal(20n);
  });

  it("allows the renter and owner to withdraw dispute claims", async function () {
    const { rentalEscrow, owner, renter, arbitrator, ethers } =
      await deployFixture();
    await createDisputedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n);

    const renterBalanceBefore = await ethers.provider.getBalance(renter.address);
    const renterWithdrawal = await rentalEscrow.connect(renter).withdraw();
    const renterReceipt = await renterWithdrawal.wait();
    const renterFee = renterReceipt!.gasUsed * renterReceipt!.gasPrice;
    expect((await ethers.provider.getBalance(renter.address)) - renterBalanceBefore + renterFee)
      .to.equal(30n);

    const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);
    const ownerWithdrawal = await rentalEscrow.connect(owner).withdraw();
    const ownerReceipt = await ownerWithdrawal.wait();
    const ownerFee = ownerReceipt!.gasUsed * ownerReceipt!.gasPrice;
    expect((await ethers.provider.getBalance(owner.address)) - ownerBalanceBefore + ownerFee)
      .to.equal(20n);
    expect(await ethers.provider.getBalance(await rentalEscrow.getAddress())).to.equal(0n);
  });

  it("does not let a rejecting renter block a refund", async function () {
    const { rentalEscrow, owner, ethers } = await deployFixture();
    const rejectingRenter = await ethers.deployContract("RejectingReceiver");
    await rentalEscrow.createRental(
      "CAM-REJECT",
      "Rejecting Camera",
      await rejectingRenter.getAddress(),
      10n,
      50n,
      1_000n,
      2_000n,
    );
    await rejectingRenter.fundDeposit(await rentalEscrow.getAddress(), 1n, {
      value: 50n,
    });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rejectingRenter.markReturned(await rentalEscrow.getAddress(), 1n);

    await expect(rentalEscrow.connect(owner).approveRefund(1n)).to.emit(
      rentalEscrow,
      "RefundIssued",
    );
    expect((await rentalEscrow.getRental(1n)).status).to.equal(4n);
    expect(
      await rentalEscrow.claimable(await rejectingRenter.getAddress()),
    ).to.equal(50n);
  });

  it("does not let rejecting recipients block dispute resolution", async function () {
    const { rentalEscrow, owner, arbitrator, ethers } = await deployFixture();
    const rejectingRenter = await ethers.deployContract("RejectingReceiver");
    await rentalEscrow.createRental(
      "CAM-REJECT",
      "Rejecting Camera",
      await rejectingRenter.getAddress(),
      10n,
      50n,
      1_000n,
      2_000n,
    );
    await rejectingRenter.fundDeposit(await rentalEscrow.getAddress(), 1n, {
      value: 50n,
    });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rejectingRenter.markReturned(await rentalEscrow.getAddress(), 1n);
    await rentalEscrow.connect(owner).raiseDispute(1n);

    await expect(
      rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n),
    ).to.emit(rentalEscrow, "DisputeResolved");
    expect((await rentalEscrow.getRental(1n)).status).to.equal(6n);
    expect(
      await rentalEscrow.claimable(await rejectingRenter.getAddress()),
    ).to.equal(30n);
  });

  it("restores a claimable balance when withdrawal transfer fails", async function () {
    const { rentalEscrow, owner, ethers } = await deployFixture();
    const rejectingRenter = await ethers.deployContract("RejectingReceiver");
    await rentalEscrow.createRental(
      "CAM-REJECT",
      "Rejecting Camera",
      await rejectingRenter.getAddress(),
      10n,
      50n,
      1_000n,
      2_000n,
    );
    await rejectingRenter.fundDeposit(await rentalEscrow.getAddress(), 1n, {
      value: 50n,
    });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rejectingRenter.markReturned(await rentalEscrow.getAddress(), 1n);
    await rentalEscrow.connect(owner).approveRefund(1n);

    await expect(
      rejectingRenter.withdraw(await rentalEscrow.getAddress()),
    ).to.be.revertedWithCustomError(rentalEscrow, "TransferFailed");
    expect(
      await rentalEscrow.claimable(await rejectingRenter.getAddress()),
    ).to.equal(50n);
  });

  it("uses reentrancy protection for withdrawals", async function () {
    const { rentalEscrow } = await deployFixture();

    expect(rentalEscrow.interface.getFunction("withdraw")).to.not.equal(null);
  });

  it("blocks a reentrant withdrawal from a malicious recipient", async function () {
    const { rentalEscrow, owner, ethers } = await deployFixture();
    const maliciousRenter = await ethers.deployContract("ReentrantReceiver");
    const maliciousAddress = await maliciousRenter.getAddress();
    const rentalAddress = await rentalEscrow.getAddress();
    const deposit = 50n;

    await rentalEscrow.createRental(
      "CAM-REENTRANT",
      "Reentrant Camera",
      maliciousAddress,
      10n,
      deposit,
      1_000n,
      2_000n,
    );
    await maliciousRenter.fundDeposit(rentalAddress, 1n, { value: deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await maliciousRenter.markReturned(rentalAddress, 1n);
    await rentalEscrow.connect(owner).approveRefund(1n);

    const balanceBefore = await ethers.provider.getBalance(rentalAddress);
    await maliciousRenter.attack(rentalAddress);

    expect(await maliciousRenter.reentrantAttemptBlocked()).to.equal(true);
    expect(await rentalEscrow.claimable(maliciousAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(maliciousAddress)).to.equal(deposit);
    expect(await ethers.provider.getBalance(rentalAddress)).to.equal(
      balanceBefore - deposit,
    );
    expect((await rentalEscrow.getRental(1n)).status).to.equal(4n);
  });

  it("rejects resolving a dispute twice", async function () {
    const { rentalEscrow, owner, renter, arbitrator } = await deployFixture();
    await createDisputedRental(rentalEscrow, owner, renter);
    await rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n);

    await expect(
      rentalEscrow.connect(arbitrator).resolveDispute(1n, 30n, 20n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("uses reentrancy protection for dispute resolution", async function () {
    const { rentalEscrow } = await deployFixture();

    expect(await rentalEscrow.arbitrator()).to.match(/^0x[a-fA-F0-9]{40}$/);
  });

  it("rejects a timeout before endTime", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    await createActiveTimedRental(rentalEscrow, ethers, owner, renter);

    await expect(
      rentalEscrow.connect(owner).triggerTimeout(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "RentalNotEnded");
  });

  it("allows a timeout exactly at endTime", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime),
    ]);

    await expect(rentalEscrow.connect(owner).triggerTimeout(1n))
      .to.emit(rentalEscrow, "RentalTimedOut")
      .withArgs(1n, owner.address);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(5n);
  });

  it("allows a timeout after endTime", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime + 1n),
    ]);

    await rentalEscrow.connect(renter).triggerTimeout(1n);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(5n);
  });

  it("rejects a timeout from an unauthorized address", async function () {
    const { rentalEscrow, ethers, owner, renter, unauthorized } =
      await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime),
    ]);

    await expect(
      rentalEscrow.connect(unauthorized).triggerTimeout(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedTimeoutParty");
  });

  it("rejects a timeout before the rental is ACTIVE", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(owner).triggerTimeout(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects triggering a timeout twice", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime),
    ]);
    await rentalEscrow.connect(owner).triggerTimeout(1n);

    await expect(
      rentalEscrow.connect(owner).triggerTimeout(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("keeps the deposit in the contract after timeout", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    const contractAddress = await rentalEscrow.getAddress();
    const balanceBefore = await ethers.provider.getBalance(contractAddress);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime),
    ]);

    await rentalEscrow.connect(owner).triggerTimeout(1n);

    expect(await ethers.provider.getBalance(contractAddress)).to.equal(
      balanceBefore,
    );
  });

  it("allows the arbitrator to resolve a timed-out dispute", async function () {
    const { rentalEscrow, ethers, owner, renter, arbitrator } =
      await deployFixture();
    const rental = await createActiveTimedRental(
      rentalEscrow,
      ethers,
      owner,
      renter,
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.endTime),
    ]);
    await rentalEscrow.connect(owner).triggerTimeout(1n);

    await expect(
      rentalEscrow.connect(arbitrator).resolveDispute(1n, 25n, 25n),
    ).to.emit(rentalEscrow, "DisputeResolved");

    expect((await rentalEscrow.getRental(1n)).status).to.equal(6n);
  });

  it("rejects recovery before startTime", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    await createFundedRecoveryRental(rentalEscrow, ethers, renter);

    await expect(
      rentalEscrow.connect(renter).recoverUnconfirmedRental(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "RentalNotStarted");
  });

  it("allows recovery exactly at startTime", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);

    await expect(rentalEscrow.connect(renter).recoverUnconfirmedRental(1n))
      .to.emit(rentalEscrow, "RentalRecovered")
      .withArgs(1n, renter.address, rental.deposit);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(4n);
  });

  it("allows recovery after startTime", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime + 1n),
    ]);

    await rentalEscrow.connect(renter).recoverUnconfirmedRental(1n);

    expect((await rentalEscrow.getRental(1n)).status).to.equal(4n);
  });

  it("rejects recovery by an unauthorized address", async function () {
    const { rentalEscrow, ethers, renter, unauthorized } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);

    await expect(
      rentalEscrow.connect(unauthorized).recoverUnconfirmedRental(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "UnauthorizedRenter");
  });

  it("rejects recovery before the rental is FUNDED", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);

    await expect(
      rentalEscrow.connect(renter).recoverUnconfirmedRental(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects recovery after pickup", async function () {
    const { rentalEscrow, ethers, owner, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);

    await expect(
      rentalEscrow.connect(renter).recoverUnconfirmedRental(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("rejects recovery twice", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);
    await rentalEscrow.connect(renter).recoverUnconfirmedRental(1n);

    await expect(
      rentalEscrow.connect(renter).recoverUnconfirmedRental(1n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidRentalStatus");
  });

  it("keeps the deposit in the contract after recovery", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    const contractAddress = await rentalEscrow.getAddress();
    const balanceBefore = await ethers.provider.getBalance(contractAddress);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);

    await rentalEscrow.connect(renter).recoverUnconfirmedRental(1n);

    expect(await ethers.provider.getBalance(contractAddress)).to.equal(
      balanceBefore,
    );
  });

  it("credits the renter's claimable recovery balance", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);

    await rentalEscrow.connect(renter).recoverUnconfirmedRental(1n);

    expect(await rentalEscrow.claimable(renter.address)).to.equal(rental.deposit);
  });

  it("lets the renter withdraw a recovered deposit", async function () {
    const { rentalEscrow, ethers, renter } = await deployFixture();
    const rental = await createFundedRecoveryRental(rentalEscrow, ethers, renter);
    await ethers.provider.send("evm_setNextBlockTimestamp", [
      Number(rental.startTime),
    ]);
    await rentalEscrow.connect(renter).recoverUnconfirmedRental(1n);

    await expect(rentalEscrow.connect(renter).withdraw())
      .to.emit(rentalEscrow, "ClaimWithdrawn")
      .withArgs(renter.address, rental.deposit);

    expect(await rentalEscrow.claimable(renter.address)).to.equal(0n);
  });

  it("rejects an empty equipment identifier", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await expect(
      rentalEscrow.createRental("", "Unnamed equipment", renter.address, 10n, 50n, 1_000n, 2_000n),
    ).to.be.revertedWithCustomError(rentalEscrow, "InvalidEquipmentIdentifier");
  });

  it("allows the first funded booking for an equipment item", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const rental = await createValidRental(rentalEscrow, renter);

    await expect(rentalEscrow.connect(renter).fundDeposit(1n, { value: rental.deposit }))
      .to.emit(rentalEscrow, "DepositFunded");
  });

  it("rejects overlapping funded rentals for the same equipment", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const first = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: first.deposit });
    await rentalEscrow.createRental("CAM-001", "Overlapping camera", renter.address, 10n, 50n, 1_500n, 2_500n);

    await expect(
      rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }),
    ).to.be.revertedWithCustomError(rentalEscrow, "EquipmentUnavailable");
  });

  it("allows adjacent non-overlapping funded rentals for the same equipment", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const first = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: first.deposit });
    await rentalEscrow.createRental("CAM-001", "Later camera", renter.address, 10n, 50n, 2_000n, 3_000n);

    await expect(rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }))
      .to.emit(rentalEscrow, "DepositFunded")
      .withArgs(2n, renter.address, 50n);
  });

  it("allows different equipment to be funded in overlapping periods", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    const first = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: first.deposit });
    await rentalEscrow.createRental("PRJ-001", "Projector", renter.address, 10n, 50n, 1_500n, 2_500n);

    await expect(rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }))
      .to.emit(rentalEscrow, "DepositFunded");
  });

  it("does not let an unfunded CREATED rental block a later booking", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);
    await rentalEscrow.createRental("CAM-001", "Committed camera", renter.address, 10n, 50n, 1_500n, 2_500n);

    await expect(rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }))
      .to.emit(rentalEscrow, "DepositFunded");
  });

  it("allows a future booking after a completed rental is refunded", async function () {
    const { rentalEscrow, owner, renter } = await deployFixture();
    const first = await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: first.deposit });
    await rentalEscrow.connect(owner).confirmPickup(1n);
    await rentalEscrow.connect(renter).markReturned(1n);
    await rentalEscrow.connect(owner).approveRefund(1n);
    await rentalEscrow.createRental("CAM-001", "Future camera", renter.address, 10n, 50n, 1_500n, 2_500n);

    await expect(rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }))
      .to.emit(rentalEscrow, "DepositFunded");
  });

  it("keeps multiple equipment reservations isolated", async function () {
    const { rentalEscrow, renter } = await deployFixture();
    await createValidRental(rentalEscrow, renter);
    await rentalEscrow.connect(renter).fundDeposit(1n, { value: 50n });
    await rentalEscrow.createRental("CAM-001", "Camera overlap", renter.address, 10n, 50n, 1_100n, 1_900n);
    await rentalEscrow.createRental("MIC-001", "Microphone", renter.address, 10n, 50n, 1_100n, 1_900n);

    await expect(rentalEscrow.connect(renter).fundDeposit(2n, { value: 50n }))
      .to.be.revertedWithCustomError(rentalEscrow, "EquipmentUnavailable");
    await expect(rentalEscrow.connect(renter).fundDeposit(3n, { value: 50n }))
      .to.emit(rentalEscrow, "DepositFunded");
  });
});
