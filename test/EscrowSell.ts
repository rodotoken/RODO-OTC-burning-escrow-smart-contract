import {
  loadFixture,
  mineUpTo,
} from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { parseUnits } from "ethers/lib/utils";
import { latestBlock } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";
import { EscrowSell, TestToken } from "../typechain-types";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
enum SellStatus {
  Pending,
  Executed,
  Claimed,
  Executeable,
  Claimeable,
}
describe("Escrow", function () {
  async function deployEscrowFixture() {
    const price = 10000000000;
    const feePercentage = parseUnits("5", 3);
    const rodoBalance = parseUnits("100000", 2);
    const escrowBlocks = 50;
    // Contracts are deployed using the first signer/account by default
    const [owner, otherAccount, lpAdmin, admin] = await ethers.getSigners();
    const TestToken = await ethers.getContractFactory("TestToken");
    const testToken = await TestToken.deploy();
    const EscrowSell = await ethers.getContractFactory("EscrowSell");
    const escrow = await EscrowSell.deploy(
      testToken.address,
      price,
      feePercentage,
      escrowBlocks,
      lpAdmin.address,
      admin.address
    );
    await testToken.transfer(escrow.address, rodoBalance);
    return {
      escrow,
      price,
      feePercentage,
      testToken,
      owner,
      otherAccount,
      admin,
      lpAdmin,
      rodoBalance,
      escrowBlocks,
    };
  }
  async function addAdminToken({
    escrow,
    testToken,
    admin,
    lpAdmin,
  }: {
    escrow: EscrowSell;
    testToken: TestToken;
    admin: SignerWithAddress;
    lpAdmin: SignerWithAddress;
  }) {
    const requiredAdminTokens = await escrow.getTotalRequiredAdminTokens();
    await testToken.transfer(admin.address, requiredAdminTokens);
    await testToken.connect(admin).approve(escrow.address, requiredAdminTokens);
    await escrow.connect(admin).addAdminTokens(requiredAdminTokens);
    const requiredLpAdminTokens = await escrow.getTotalRequiredLpAdminTokens();
    await testToken
      .connect(lpAdmin)
      .approve(escrow.address, requiredLpAdminTokens[0]);
    await testToken.transfer(lpAdmin.address, requiredLpAdminTokens[0]);
    await escrow.connect(lpAdmin).addLpAdminTokens(requiredLpAdminTokens[0], {
      value: requiredLpAdminTokens[1],
    });
  }

  describe("Deployment", function () {
    it("Should set the right price", async function () {
      const { escrow, price } = await loadFixture(deployEscrowFixture);

      expect(await escrow.price()).to.equal(price);
    });

    it("Should set the right owner", async function () {
      const { escrow, owner } = await loadFixture(deployEscrowFixture);

      expect(await escrow.owner()).to.equal(owner.address);
    });

    it("Should set the right fee percentage", async function () {
      const { escrow, feePercentage } = await loadFixture(deployEscrowFixture);

      expect(await escrow.feePercentage()).to.equal(feePercentage);
    });

    it("Should set the right escrow blocks", async function () {
      const { escrow } = await loadFixture(deployEscrowFixture);

      expect(await escrow.escrowBlocks()).to.equal(50);
    });

    it("Should set the right admins", async function () {
      const { escrow, lpAdmin, admin } = await loadFixture(deployEscrowFixture);

      expect(await escrow.lpAdmin()).to.equal(lpAdmin.address);
      expect(await escrow.admin()).to.equal(admin.address);
    });

    it("Should set the right rodo address", async function () {
      const { escrow, testToken } = await loadFixture(deployEscrowFixture);
      expect(await escrow.rodo()).to.equal(testToken.address);
    });

    it("Should have the right rodo balance", async function () {
      const { escrow, testToken, rodoBalance } = await loadFixture(
        deployEscrowFixture
      );
      expect(await testToken.balanceOf(escrow.address)).to.equal(rodoBalance);
    });
  });

  describe("Sell", function () {
    it("should not allow 0 amount to sell", async () => {
      const { escrow, testToken, owner, rodoBalance } = await loadFixture(
        deployEscrowFixture
      );
      await expect(escrow.sell(0)).revertedWith("Escrow: Amount cannot be 0");
    });

    it("should fail if not approved", async () => {
      const { escrow, testToken, owner, rodoBalance } = await loadFixture(
        deployEscrowFixture
      );
      await expect(escrow.sell(parseUnits("1000"))).revertedWith(
        "ERC20: insufficient allowance"
      );
    });

    it("should allow to sell", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      await testToken.approve(escrow.address, amount);
      await expect(escrow.sell(balance)).to.changeTokenBalances(
        testToken,
        [owner, escrow],
        [`-${amount.toString()}`, amount]
      );
      const currentBlock = await latestBlock();
      const sellInfo = await escrow.sellInfo(owner.address, 0);
      expect(sellInfo.amount).to.be.equal(balance);
      expect(sellInfo.feeAmount).to.be.equal(fee);
      expect(sellInfo.startBlock).to.be.equal(currentBlock);
      expect(sellInfo.endBlock).to.be.equal(currentBlock + escrowBlocks);
      expect(sellInfo.status).to.be.equals(0);
    });
  });

  describe("execute", function () {
    it("should not execute if endblock passed", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
        lpAdmin,
        admin,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      await testToken.approve(escrow.address, amount);
      expect(await escrow.sell(balance)).to.be.ok;
      const currentBlock = await latestBlock();
      await mineUpTo(currentBlock + escrowBlocks);
      // send tokens to sc
      await addAdminToken({ escrow, testToken, admin, lpAdmin });
      await expect(escrow.execute(0)).to.revertedWith("Escrow: invalid block");
    });

    it("should be able to execute", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
        lpAdmin,
        admin,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      const ethRequired = await escrow.getRequiredEth(balance);
      await testToken.approve(escrow.address, amount);
      expect(await escrow.sell(balance)).to.be.ok;
      // send tokens to sc
      await addAdminToken({ escrow, testToken, admin, lpAdmin });
      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Executeable
      );

      let [totalAdminTokens, lpRequiredtokens, totalSellQueueTokens] =
        await Promise.all([
          escrow.totalAdminTokens(),
          escrow.totalLpTokens(),
          escrow.totalSellQueueTokens(),
        ]);
      await expect(escrow.execute(0))
        .to.changeEtherBalances(
          [escrow, owner],
          [`-${ethRequired.toString()}`, ethRequired]
        )
        .changeTokenBalances(
          testToken,
          [escrow, admin],
          [`-${amount.toString()}`, fee]
        );
      const sellInfo = await escrow.sellInfo(owner.address, 0);
      expect(sellInfo.status).to.be.equal(SellStatus.Executed);
      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Executed
      );
      expect(await escrow.totalAdminTokens()).to.be.equals(
        totalAdminTokens.sub(balance.mul(20).div(100))
      );
      expect(await escrow.totalLpTokens()).to.be.equals(
        lpRequiredtokens.sub(balance.mul(80).div(100))
      );
      expect(await escrow.totalSellQueueTokens()).to.be.equals(
        totalSellQueueTokens.sub(balance)
      );
    });
  });

  describe("Claim", function () {
    it("should allow to claim after blocks", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      await testToken.approve(escrow.address, amount);
      await expect(escrow.sell(balance)).to.changeTokenBalances(
        testToken,
        [owner, escrow],
        [`-${amount.toString()}`, amount]
      );

      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Pending
      );
      const currentBlock = await latestBlock();
      await mineUpTo(currentBlock + escrowBlocks * 2);
      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Claimeable
      );
      await expect(escrow.claim(0)).to.changeTokenBalances(
        testToken,
        [escrow, owner],
        [`-${amount.toString()}`, amount]
      );
      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Claimed
      );
    });

    it("should not allow dual claim", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      await testToken.approve(escrow.address, amount);
      await expect(escrow.sell(balance)).to.changeTokenBalances(
        testToken,
        [owner, escrow],
        [`-${amount.toString()}`, amount]
      );

      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Pending
      );
      const currentBlock = await latestBlock();
      await mineUpTo(currentBlock + escrowBlocks * 2);
      expect(await escrow.claim(0)).to.be.ok;
      await expect(escrow.claim(0)).to.be.revertedWith(
        "Escrow: invalid status"
      );
    });

    it("should not allow to execute after claim", async () => {
      const {
        escrow,
        testToken,
        owner,
        rodoBalance,
        feePercentage,
        escrowBlocks,
        lpAdmin,
        admin,
      } = await loadFixture(deployEscrowFixture);
      const balance = parseUnits("1000", 2);
      const fee = balance.mul(feePercentage).div(1e5);
      const amount = balance.add(fee);
      await testToken.approve(escrow.address, amount);
      await expect(escrow.sell(balance)).to.changeTokenBalances(
        testToken,
        [owner, escrow],
        [`-${amount.toString()}`, amount]
      );

      expect(await escrow.status(owner.address, 0)).to.be.equal(
        SellStatus.Pending
      );
      await addAdminToken({ escrow, testToken, admin, lpAdmin });
      const currentBlock = await latestBlock();
      await mineUpTo(currentBlock + escrowBlocks * 2);
      expect(await escrow.claim(0)).to.be.ok;
      await expect(escrow.execute(0)).to.be.revertedWith(
        "Escrow: invalid block"
      );
    });
  });

  describe("OnlyOwner", function () {
    it("should be able to update price", async () => {
      const { escrow } = await loadFixture(deployEscrowFixture);
      await escrow.updatePrice(parseUnits("1"));
      expect(await escrow.price()).to.be.equals(parseUnits("1"));
    });
    it("should be able to update admin", async () => {
      const { escrow, owner } = await loadFixture(deployEscrowFixture);
      await escrow.updateAdmin(owner.address);
      expect(await escrow.owner()).to.be.equals(owner.address);
    });
    it("should be able to update lpAdmin", async () => {
      const { escrow, owner } = await loadFixture(deployEscrowFixture);
      await escrow.updateLpAdmin(owner.address);
      expect(await escrow.lpAdmin()).to.be.equals(owner.address);
    });
    it("should be able to update fee Percentage", async () => {
      const { escrow } = await loadFixture(deployEscrowFixture);
      await escrow.updateFeePercentage(parseUnits("1", 3));
      expect(await escrow.feePercentage()).to.be.equals(parseUnits("1", 3));
    });
    it("should be able to update escrow", async () => {
      const { escrow } = await loadFixture(deployEscrowFixture);
      await escrow.updateEscrowBlocks(100);
      expect(await escrow.escrowBlocks()).to.be.equals(100);
    });
    it("should be able to update rodo token", async () => {
      const { escrow, owner } = await loadFixture(deployEscrowFixture);
      await escrow.updateRodo(owner.address);
      expect(await escrow.rodo()).to.be.equals(owner.address);
    });

    it("should be able to withdraw token", async () => {
      const { escrow, testToken, owner } = await loadFixture(
        deployEscrowFixture
      );
      const tokens = parseUnits("1000", 2);
      await expect(
        escrow.withdrawToken(testToken.address, tokens)
      ).to.changeTokenBalances(
        testToken,
        [escrow.address, owner.address],
        [`-${tokens.toString()}`, tokens.toString()]
      );
    });
  });
});
