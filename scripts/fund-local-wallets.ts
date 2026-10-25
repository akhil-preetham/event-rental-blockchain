import { network } from "hardhat";

const { ethers } = await network.connect();

const wallets = [
  {
    name: "Owner",
    address: "0x9a512E2f1A6B5FB6D7b6bb58b159420c7ddE4BEE",
  },
  {
    name: "Renter",
    address: "0xe80b23a66B2a02072C900a4413Ef6b914A2C60dd",
  },
];

const [funder] = await ethers.getSigners();
const funderAddress = await funder.getAddress();
const chainId = (await ethers.provider.getNetwork()).chainId;

if (chainId !== 31337n) {
  throw new Error(`Refusing to fund wallets on unexpected chain ${chainId}`);
}

console.log(`Local chain ID: ${chainId}`);
console.log(`Funder: ${funderAddress}`);

for (const wallet of wallets) {
  const before = await ethers.provider.getBalance(wallet.address);
  console.log(`${wallet.name} balance before: ${ethers.formatEther(before)} ETH`);

  if (before < ethers.parseEther("10")) {
    const tx = await funder.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther("10"),
    });

    console.log(`${wallet.name} funding transaction: ${tx.hash}`);
    await tx.wait();
  }

  const after = await ethers.provider.getBalance(wallet.address);
  console.log(`${wallet.name} balance after: ${ethers.formatEther(after)} ETH`);
}
