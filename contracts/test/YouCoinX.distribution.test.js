const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("YouCoinX Distribution Tests", function () {
    let YouCoinX;
    let token;
    let owner;
    let presaleWallet;
    let liquidityWallet;
    let rewardsPoolWallet;
    let operationalWallet;
    let addr1;
    let addr2;

    // Constantes para distribuição
    const INITIAL_SUPPLY = ethers.parseEther("8045311447");
    const PRESALE_PERCENT = 51;
    const LIQUIDITY_PERCENT = 20;
    const REWARDS_POOL_PERCENT = 20;
    const OPERATIONAL_PERCENT = 9;

    // Valores exatos para cada carteira
    const PRESALE_AMOUNT = INITIAL_SUPPLY * BigInt(PRESALE_PERCENT) / 100n;
    const LIQUIDITY_AMOUNT = INITIAL_SUPPLY * BigInt(LIQUIDITY_PERCENT) / 100n;
    const REWARDS_POOL_AMOUNT = INITIAL_SUPPLY * BigInt(REWARDS_POOL_PERCENT) / 100n;
    const OPERATIONAL_AMOUNT = INITIAL_SUPPLY * BigInt(OPERATIONAL_PERCENT) / 100n;

    beforeEach(async function () {
        [owner, presaleWallet, liquidityWallet, rewardsPoolWallet, operationalWallet, addr1, addr2] = await ethers.getSigners();
        
        YouCoinX = await ethers.getContractFactory("YouCoinX");
        token = await upgrades.deployProxy(YouCoinX, [
            presaleWallet.address,
            liquidityWallet.address,
            rewardsPoolWallet.address,
            operationalWallet.address
        ]);
        await token.waitForDeployment();
    });

    describe("Initial Distribution", function () {
        it("Should distribute exact amounts to each wallet", async function () {
            expect(await token.balanceOf(presaleWallet.address)).to.equal(PRESALE_AMOUNT);
            expect(await token.balanceOf(liquidityWallet.address)).to.equal(LIQUIDITY_AMOUNT);
            expect(await token.balanceOf(rewardsPoolWallet.address)).to.equal(REWARDS_POOL_AMOUNT);
            expect(await token.balanceOf(operationalWallet.address)).to.equal(OPERATIONAL_AMOUNT);

            // Verificar supply total
            expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);
        });

        it("Should have correct percentage distribution", async function () {
            const totalSupply = await token.totalSupply();
            
            const presaleBalance = await token.balanceOf(presaleWallet.address);
            const liquidityBalance = await token.balanceOf(liquidityWallet.address);
            const rewardsBalance = await token.balanceOf(rewardsPoolWallet.address);
            const operationalBalance = await token.balanceOf(operationalWallet.address);

            expect(presaleBalance * 100n / totalSupply).to.equal(BigInt(PRESALE_PERCENT));
            expect(liquidityBalance * 100n / totalSupply).to.equal(BigInt(LIQUIDITY_PERCENT));
            expect(rewardsBalance * 100n / totalSupply).to.equal(BigInt(REWARDS_POOL_PERCENT));
            expect(operationalBalance * 100n / totalSupply).to.equal(BigInt(OPERATIONAL_PERCENT));
        });
    });

    describe("Growth Distribution", function () {
        it("Should execute annual growth with correct distribution", async function () {
            // Avançar o tempo em 1 ano
            await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");

            await token.executeAnnualGrowth();

            const totalGrowth = INITIAL_SUPPLY * 11n / 1000n; // 1.1%
            const rewardsPoolGrowth = totalGrowth * 80n / 100n;
            const operationalGrowth = totalGrowth * 20n / 100n;

            // Verificar distribuição do crescimento
            const newRewardsBalance = REWARDS_POOL_AMOUNT + rewardsPoolGrowth;
            const newOperationalBalance = OPERATIONAL_AMOUNT + operationalGrowth;

            expect(await token.balanceOf(rewardsPoolWallet.address)).to.equal(newRewardsBalance);
            expect(await token.balanceOf(operationalWallet.address)).to.equal(newOperationalBalance);

            // Verificar que outras carteiras não mudaram
            expect(await token.balanceOf(presaleWallet.address)).to.equal(PRESALE_AMOUNT);
            expect(await token.balanceOf(liquidityWallet.address)).to.equal(LIQUIDITY_AMOUNT);
        });

        it("Should apply transaction fees correctly", async function () {
            const transferAmount = ethers.parseEther("1000");
            const expectedFeeRate = 11n; // 1.1%
            
            // Primeiro transferir do presaleWallet para addr1 e calcular primeira taxa
            await token.connect(presaleWallet).transfer(addr1.address, transferAmount);
            const firstFee = (transferAmount * expectedFeeRate) / 1000n;
            const firstRewardsPoolFee = (firstFee * 80n) / 100n;
            const firstOperationalFee = firstFee - firstRewardsPoolFee;
            
            // Então transferir de addr1 para addr2 e calcular segunda taxa
            await token.connect(addr1).transfer(addr2.address, transferAmount);
            const secondFee = (transferAmount * expectedFeeRate) / 1000n;
            const secondRewardsPoolFee = (secondFee * 80n) / 100n;
            const secondOperationalFee = secondFee - secondRewardsPoolFee;
            
            // Verificar o saldo do addr2 (deve receber o valor total)
            const receivedAmount = await token.balanceOf(addr2.address);
            expect(receivedAmount).to.equal(transferAmount);

            // Verificar saldos das carteiras de taxa (soma das duas taxas)
            const rewardsPoolBalance = await token.balanceOf(rewardsPoolWallet.address);
            const operationalBalance = await token.balanceOf(operationalWallet.address);

            expect(rewardsPoolBalance).to.equal(REWARDS_POOL_AMOUNT + firstRewardsPoolFee + secondRewardsPoolFee);
            expect(operationalBalance).to.equal(OPERATIONAL_AMOUNT + firstOperationalFee + secondOperationalFee);
        });

        it("Should emit AnnualGrowthExecuted event with correct amounts", async function () {
            await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");

            const totalGrowth = INITIAL_SUPPLY * 11n / 1000n;
            const rewardsPoolGrowth = totalGrowth * 80n / 100n;
            const operationalGrowth = totalGrowth * 20n / 100n;

            await expect(token.executeAnnualGrowth())
                .to.emit(token, "AnnualGrowthExecuted")
                .withArgs(totalGrowth, rewardsPoolGrowth, operationalGrowth);
        });

        it("Should not allow growth execution before one year", async function () {
            await expect(token.executeAnnualGrowth())
                .to.be.revertedWithCustomError(token, "GrowthTooEarly");
        });
    });

    describe("Transaction Fees", function () {
        it("Should apply minimum transaction fee correctly", async function () {
            const transferAmount = ethers.parseEther("1000");
            const minFee = 10n; // 1%
            
            // Definir taxa mínima
            await token.setTransactionFee(minFee);
            
            // Transferir do presaleWallet para addr1 e calcular primeira taxa
            await token.connect(presaleWallet).transfer(addr1.address, transferAmount);
            const firstFee = (transferAmount * minFee) / 1000n;
            const firstRewardsPoolFee = (firstFee * 80n) / 100n;
            const firstOperationalFee = firstFee - firstRewardsPoolFee;
            
            // Transferir de addr1 para addr2 e calcular segunda taxa
            await token.connect(addr1).transfer(addr2.address, transferAmount);
            const secondFee = (transferAmount * minFee) / 1000n;
            const secondRewardsPoolFee = (secondFee * 80n) / 100n;
            const secondOperationalFee = secondFee - secondRewardsPoolFee;
            
            // Verificar o saldo do addr2 (deve receber o valor total)
            const receivedAmount = await token.balanceOf(addr2.address);
            expect(receivedAmount).to.equal(transferAmount);

            // Verificar saldos das carteiras de taxa (soma das duas taxas)
            const rewardsPoolBalance = await token.balanceOf(rewardsPoolWallet.address);
            const operationalBalance = await token.balanceOf(operationalWallet.address);

            expect(rewardsPoolBalance).to.equal(REWARDS_POOL_AMOUNT + firstRewardsPoolFee + secondRewardsPoolFee);
            expect(operationalBalance).to.equal(OPERATIONAL_AMOUNT + firstOperationalFee + secondOperationalFee);
        });

        it("Should apply maximum transaction fee correctly", async function () {
            const transferAmount = ethers.parseEther("1000");
            const maxFee = 30n; // 3%
            
            // Definir taxa máxima
            await token.setTransactionFee(maxFee);
            
            // Transferir do presaleWallet para addr1 e calcular primeira taxa
            await token.connect(presaleWallet).transfer(addr1.address, transferAmount);
            const firstFee = (transferAmount * maxFee) / 1000n;
            const firstRewardsPoolFee = (firstFee * 80n) / 100n;
            const firstOperationalFee = firstFee - firstRewardsPoolFee;
            
            // Transferir de addr1 para addr2 e calcular segunda taxa
            await token.connect(addr1).transfer(addr2.address, transferAmount);
            const secondFee = (transferAmount * maxFee) / 1000n;
            const secondRewardsPoolFee = (secondFee * 80n) / 100n;
            const secondOperationalFee = secondFee - secondRewardsPoolFee;
            
            // Verificar o saldo do addr2 (deve receber o valor total)
            const receivedAmount = await token.balanceOf(addr2.address);
            expect(receivedAmount).to.equal(transferAmount);

            // Verificar saldos das carteiras de taxa (soma das duas taxas)
            const rewardsPoolBalance = await token.balanceOf(rewardsPoolWallet.address);
            const operationalBalance = await token.balanceOf(operationalWallet.address);

            expect(rewardsPoolBalance).to.equal(REWARDS_POOL_AMOUNT + firstRewardsPoolFee + secondRewardsPoolFee);
            expect(operationalBalance).to.equal(OPERATIONAL_AMOUNT + firstOperationalFee + secondOperationalFee);
        });

        it("Should not allow setting fee outside allowed range", async function () {
            await expect(token.setTransactionFee(9)) // Menor que 1%
                .to.be.revertedWithCustomError(token, "TransactionFeeOutOfRange");
            
            await expect(token.setTransactionFee(31)) // Maior que 3%
                .to.be.revertedWithCustomError(token, "TransactionFeeOutOfRange");
        });
    });

    describe("Distribution Validation", function () {
        it("Should not allow initialization with zero addresses", async function () {
            const tokenFactory = await ethers.getContractFactory("YouCoinX");
            await expect(upgrades.deployProxy(tokenFactory, [
                ethers.ZeroAddress,
                liquidityWallet.address,
                rewardsPoolWallet.address,
                operationalWallet.address
            ])).to.be.revertedWithCustomError(tokenFactory, "InvalidWallet");
        });

        it("Should not allow duplicate wallet addresses", async function () {
            const tokenFactory = await ethers.getContractFactory("YouCoinX");
            await expect(upgrades.deployProxy(tokenFactory, [
                presaleWallet.address,
                presaleWallet.address, // Duplicado
                rewardsPoolWallet.address,
                operationalWallet.address
            ])).to.be.revertedWithCustomError(tokenFactory, "DuplicateWallet");
        });
    });
});
