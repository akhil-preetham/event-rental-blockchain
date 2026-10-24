import { expect } from "chai";
import { network } from "hardhat";

describe("Hardhat environment", function () {
  it("connects to the local network with a funded signer", async function () {
    const { ethers } = await network.connect();
    const [signer] = await ethers.getSigners();

    expect(await signer.getAddress()).to.match(/^0x[a-fA-F0-9]{40}$/);
    expect(await ethers.provider.getBalance(signer.address)).to.be.gt(0n);
  });
});
