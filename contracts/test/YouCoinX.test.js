const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("YouCoinX", function () {
    let YouCoinX;
    let token;
    let owner;
    let presaleWallet;
    let liquidityWallet;
    let rewardsPoolWallet;
    let operationalWallet;
    let addr1;
    let addr2;
    let addrs;

    // Constantes
    const INITIAL_SUPPLY = ethers.parseEther("8045311447");
    const PRESALE_PERCENT = 51;
    const LIQUIDITY_PERCENT = 20;
    const REWARDS_POOL_PERCENT = 20;
    const OPERATIONAL_PERCENT = 9;
    const ANNUAL_GROWTH_RATE = 11; // 1.1%

    beforeEach(async function () {
        [owner, presaleWallet, liquidityWallet, rewardsPoolWallet, operationalWallet, addr1, addr2, ...addrs] = await ethers.getSigners();
        
        YouCoinX = await ethers.getContractFactory("YouCoinX");
        token = await upgrades.deployProxy(YouCoinX, [
            presaleWallet.address,
            liquidityWallet.address,
            rewardsPoolWallet.address,
            operationalWallet.address
        ]);
        await token.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            expect(await token.owner()).to.equal(owner.address);
        });

        it("Should distribute tokens correctly to all wallets", async function () {
            const presaleBalance = await token.balanceOf(presaleWallet.address);
            const liquidityBalance = await token.balanceOf(liquidityWallet.address);
            const rewardsBalance = await token.balanceOf(rewardsPoolWallet.address);
            const operationalBalance = await token.balanceOf(operationalWallet.address);

            expect(presaleBalance).to.equal(INITIAL_SUPPLY * BigInt(PRESALE_PERCENT) / 100n);
            expect(liquidityBalance).to.equal(INITIAL_SUPPLY * BigInt(LIQUIDITY_PERCENT) / 100n);
            expect(rewardsBalance).to.equal(INITIAL_SUPPLY * BigInt(REWARDS_POOL_PERCENT) / 100n);
            expect(operationalBalance).to.equal(INITIAL_SUPPLY * BigInt(OPERATIONAL_PERCENT) / 100n);
        });

        it("Should have correct initial supply", async function () {
            const totalSupply = await token.totalSupply();
            expect(totalSupply).to.equal(INITIAL_SUPPLY);
        });

        it("Should initialize with 1.1% growth rate", async function () {
            expect(await token.getAnnualGrowthRate()).to.equal(ANNUAL_GROWTH_RATE);
        });
    });

    describe("Annual Growth", function () {
        it("Should execute annual growth correctly", async function () {
            // Avançar o tempo em 1 ano
            await time.increase(365 * 24 * 60 * 60);

            // Executar o crescimento anual
            await expect(token.executeAnnualGrowth())
                .to.emit(token, "AnnualGrowthExecuted");

            // Verificar se o supply aumentou corretamente
            const expectedGrowth = INITIAL_SUPPLY * BigInt(ANNUAL_GROWTH_RATE) / 1000n;
            const newSupply = await token.totalSupply();
            expect(newSupply).to.equal(INITIAL_SUPPLY + expectedGrowth);
        });

        it("Should not allow growth execution before one year", async function () {
            await time.increase(364 * 24 * 60 * 60); // Menos de 1 ano
            await expect(token.executeAnnualGrowth())
                .to.be.revertedWithCustomError(token, "GrowthTooEarly");
        });
    });

    describe("Token Operations", function () {
        describe("Transfers", function () {
            it("Should transfer tokens between accounts", async function () {
                const amount = ethers.parseEther("1000");
                await token.connect(presaleWallet).transfer(addr1.address, amount);
                
                const addr1Balance = await token.balanceOf(addr1.address);
                expect(addr1Balance).to.equal(amount);
            });

            it("Should fail if sender has insufficient balance", async function () {
                const initialBalance = await token.balanceOf(addr1.address);
                await expect(token.connect(addr1).transfer(addr2.address, initialBalance + 1n))
                    .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
            });
        });

        describe("Approvals", function () {
            const amount = ethers.parseEther("1000");

            it("Should approve spending of tokens", async function () {
                await token.connect(presaleWallet).approve(addr1.address, amount);
                expect(await token.allowance(presaleWallet.address, addr1.address))
                    .to.equal(amount);
            });

            it("Should emit Approval event", async function () {
                await expect(token.connect(presaleWallet).approve(addr1.address, amount))
                    .to.emit(token, "Approval")
                    .withArgs(presaleWallet.address, addr1.address, amount);
            });
        });

        describe("TransferFrom", function () {
            const amount = ethers.parseEther("1000");

            beforeEach(async function () {
                await token.connect(presaleWallet).approve(addr1.address, amount);
            });

            it("Should transfer tokens using transferFrom", async function () {
                await token.connect(addr1).transferFrom(presaleWallet.address, addr2.address, amount);
                expect(await token.balanceOf(addr2.address)).to.equal(amount);
            });

            it("Should fail if allowance is insufficient", async function () {
                const largeAmount = ethers.parseEther("2000");
                await expect(token.connect(addr1).transferFrom(presaleWallet.address, addr2.address, largeAmount))
                    .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
            });
        });
    });

    describe("Growth Rate Management", function () {
        it("Should allow owner to update growth rate", async function () {
            await token.setAnnualGrowthRate(20);
            expect(await token.getAnnualGrowthRate()).to.equal(20);
        });

        it("Should emit event when growth rate is updated", async function () {
            await expect(token.setAnnualGrowthRate(20))
                .to.emit(token, "GrowthRateUpdated")
                .withArgs(ANNUAL_GROWTH_RATE, 20);
        });

        it("Should revert if non-owner tries to update growth rate", async function () {
            await expect(token.connect(addr1).setAnnualGrowthRate(20))
                .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
                .withArgs(addr1.address);
        });

        it("Should revert if growth rate exceeds maximum", async function () {
            await expect(token.setAnnualGrowthRate(101))
                .to.be.revertedWithCustomError(token, "GrowthRateExceedsMax");
        });
    });

    describe("Transaction Fee Management", function () {
        it("Should initialize with default transaction fee", async function () {
            expect(await token.getTransactionFee()).to.equal(11); // 1.1% inicial
        });

        it("Should allow owner to update transaction fee", async function () {
            const newFee = 20; // 2%
            await token.setTransactionFee(newFee);
            expect(await token.getTransactionFee()).to.equal(newFee);
        });

        it("Should emit event when transaction fee is updated", async function () {
            const newFee = 20; // 2%
            await expect(token.setTransactionFee(newFee))
                .to.emit(token, "TransactionFeeUpdated")
                .withArgs(11, newFee); // de 1.1% para 2%
        });

        it("Should revert if non-owner tries to update transaction fee", async function () {
            await expect(token.connect(addr1).setTransactionFee(20))
                .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
        });

        it("Should revert if fee is below minimum (1%)", async function () {
            await expect(token.setTransactionFee(9))
                .to.be.revertedWithCustomError(token, "TransactionFeeOutOfRange");
        });

        it("Should revert if fee is above maximum (3%)", async function () {
            await expect(token.setTransactionFee(31))
                .to.be.revertedWithCustomError(token, "TransactionFeeOutOfRange");
        });
    });

    describe("Module Management", function () {
        let TestModule;
        let testModule;

        beforeEach(async function () {
            TestModule = await ethers.getContractFactory("TestModule");
            testModule = await TestModule.deploy(await token.getAddress());
            await testModule.waitForDeployment();
        });

        it("Should register a valid module", async function () {
            const moduleAddress = await testModule.getAddress();
            await token.registerModule(moduleAddress);
            expect(await token.isModuleRegistered(moduleAddress)).to.be.true;
        });

        it("Should unregister a module", async function () {
            const moduleAddress = await testModule.getAddress();
            await token.registerModule(moduleAddress);
            await token.unregisterModule(moduleAddress);
            expect(await token.isModuleRegistered(moduleAddress)).to.be.false;
        });

        it("Should revert when registering same module twice", async function () {
            const moduleAddress = await testModule.getAddress();
            await token.registerModule(moduleAddress);
            await expect(token.registerModule(moduleAddress))
                .to.be.revertedWithCustomError(token, "ModuleAlreadyRegistered");
        });
    });
});
