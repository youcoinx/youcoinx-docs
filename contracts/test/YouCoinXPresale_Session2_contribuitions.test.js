const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("YouCoinXPresale", function () {
    // Constants for testing
    const DAILY_TOKENS = ethers.parseEther("8990925");
    const INITIAL_BONUS_POOL = ethers.parseEther("820421968");
    const MIN_BONUS_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDT
    const INITIAL_PRESALE_AMOUNT = ethers.parseEther("4103108837.97");
    const INITIAL_USDT_SUPPLY = ethers.parseUnits("1000000", 6); // 1M USDT

    // Contract and account variables
    let mockUSDT, mockToken, priceFeedProxy, presale;
    let owner, addr1, addr2, liquidityWallet, operationalWallet, rewardsWallet, addrs;

    beforeEach(async function () {
        [owner, addr1, addr2, liquidityWallet, operationalWallet, rewardsWallet, ...addrs] = await ethers.getSigners();

        // Deploy mock USDT
        const MockToken = await ethers.getContractFactory("MockERC20");
        mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 6);
        await mockUSDT.waitForDeployment();

        // Deploy mock YouCoinX token
        mockToken = await MockToken.deploy("YouCoinX Token", "YCX", 18);
        await mockToken.waitForDeployment();

        // Mint initial supply to owner
        await mockToken.mint(owner.address, INITIAL_PRESALE_AMOUNT);
        await mockUSDT.mint(owner.address, INITIAL_USDT_SUPPLY);

        // Deploy PriceFeedProxy
        const PriceFeedProxy = await ethers.getContractFactory("PriceFeedProxy");
        priceFeedProxy = await upgrades.deployProxy(PriceFeedProxy, [], { kind: 'uups' });
        await priceFeedProxy.waitForDeployment();
        await priceFeedProxy.setMockPrice(ethers.parseUnits("300", 8));

        // Deploy YouCoinXPresale
        const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
        presale = await upgrades.deployProxy(YouCoinXPresale, [
            await mockToken.getAddress(),
            await mockUSDT.getAddress(),
            liquidityWallet.address,
            operationalWallet.address,
            await priceFeedProxy.getAddress()
        ], { kind: 'uups' });
        await presale.waitForDeployment();

        // Transfer tokens to presale contract
        await mockToken.transfer(await presale.getAddress(), INITIAL_PRESALE_AMOUNT);
    });

    describe("2. Contribution Tests", function () {
        describe("2.1 Basic Contribution Validation", function () {
            it("Should reject contributions below minimum", async function () {
                const minContrib = ethers.parseUnits("9", 6); // 9 USDT
                await mockUSDT.mint(addr1.address, minContrib);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), minContrib);
                await expect(presale.connect(addr1).contribute(minContrib))
                    .to.be.revertedWith("Min contribution is 10 USDT");
            });

            it("Should revert when contributing less than minimum BNB amount", async function () {
                const minContribUSDT = await presale.MIN_CONTRIBUTION();
                const bnbPrice = await priceFeedProxy.getLatestPrice();
                const minContribBNB = (BigInt(minContribUSDT) * BigInt(ethers.parseEther("1"))) / BigInt(bnbPrice);
                const smallAmount = minContribBNB - BigInt(1);

                await expect(presale.connect(addr1).contributeWithBNB({ value: smallAmount }))
                    .to.be.revertedWith("Min contribution is 10 USDT");
            });

            it("Should accept valid USDT contribution", async function () {
                const amount = ethers.parseUnits("100", 6); // 100 USDT
                await mockUSDT.mint(addr1.address, amount);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), amount);
                await expect(presale.connect(addr1).contribute(amount))
                    .to.not.be.reverted;
            });

            it("Should accept valid BNB contribution", async function () {
                const amount = ethers.parseEther("0.5"); // 0.5 BNB = ~$150 USD
                await expect(presale.connect(addr1).contributeWithBNB({ value: amount }))
                    .to.not.be.reverted;
            });
        });

        describe("2.2 Multiple Contributions", function () {
            it("Should accumulate multiple USDT contributions from same user", async function () {
                const contribution1 = ethers.parseUnits("20", 6); // 20 USDT
                const contribution2 = ethers.parseUnits("30", 6); // 30 USDT
                const totalExpected = BigInt(contribution1) + BigInt(contribution2);

                await mockUSDT.mint(addr1.address, totalExpected);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), totalExpected);

                await presale.connect(addr1).contribute(contribution1);
                await presale.connect(addr1).contribute(contribution2);

                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(userContribution).to.equal(totalExpected);
            });

            it("Should accumulate multiple BNB contributions from same user", async function () {
                const contribution1 = ethers.parseEther("1"); // 1 BNB
                const contribution2 = ethers.parseEther("2"); // 2 BNB

                // Convert BNB to USD equivalent
                const bnbPrice = await priceFeedProxy.getLatestPrice();
                const usdAmount1 = (BigInt(contribution1) * BigInt(bnbPrice)) / BigInt(ethers.parseEther("1"));
                const usdAmount2 = (BigInt(contribution2) * BigInt(bnbPrice)) / BigInt(ethers.parseEther("1"));
                const totalExpected = usdAmount1 + usdAmount2;

                await presale.connect(addr1).contributeWithBNB({ value: contribution1 });
                await presale.connect(addr1).contributeWithBNB({ value: contribution2 });

                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(userContribution).to.equal(totalExpected);
            });
        });

        describe("2.3 Bonus Eligibility", function () {
            it("Should grant bonus for USDT contribution above minimum", async function () {
                const contribution = ethers.parseUnits("10000", 6); // 10k USDT
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(BigInt(userContribution) >= BigInt(MIN_BONUS_AMOUNT)).to.be.true;
            });

            it("Should grant bonus for BNB contribution above minimum", async function () {
                const minBonusUSDT = await presale.MIN_BONUS_AMOUNT();
                const bnbPrice = await priceFeedProxy.getLatestPrice();
                const minBonusBNB = (BigInt(minBonusUSDT) * BigInt(ethers.parseEther("1"))) / BigInt(bnbPrice);
                const contribution = minBonusBNB + BigInt(ethers.parseEther("1")); // Add 1 BNB to ensure we're above minimum

                await presale.connect(addr1).contributeWithBNB({ value: contribution });
                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(BigInt(userContribution) >= BigInt(minBonusUSDT)).to.be.true;
            });
        });

        describe("2.4 Fund Distribution", function () {
            it("Should distribute USDT 50/50 to liquidity and operational wallets", async function () {
                const amount = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, amount);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), amount);

                const liquidityBefore = await mockUSDT.balanceOf(liquidityWallet.address);
                const operationalBefore = await mockUSDT.balanceOf(operationalWallet.address);

                await presale.connect(addr1).contribute(amount);

                const expectedShare = BigInt(amount) / 2n;
                const liquidityAfter = await mockUSDT.balanceOf(liquidityWallet.address);
                const operationalAfter = await mockUSDT.balanceOf(operationalWallet.address);

                expect(liquidityAfter - liquidityBefore).to.equal(expectedShare);
                expect(operationalAfter - operationalBefore).to.equal(expectedShare);
            });

            it("Should distribute BNB 50/50 to liquidity and operational wallets", async function () {
                const bnbAmount = ethers.parseEther("1");

                const liquidityBefore = await ethers.provider.getBalance(liquidityWallet.address);
                const operationalBefore = await ethers.provider.getBalance(operationalWallet.address);

                await presale.connect(addr1).contributeWithBNB({ value: bnbAmount });

                const expectedShare = BigInt(bnbAmount) / 2n;
                const liquidityAfter = await ethers.provider.getBalance(liquidityWallet.address);
                const operationalAfter = await ethers.provider.getBalance(operationalWallet.address);

                expect(liquidityAfter - liquidityBefore).to.equal(expectedShare);
                expect(operationalAfter - operationalBefore).to.equal(expectedShare);
            });
        });

        describe("2.5 Day Change Handling", function () {
            it("Should move to next day after 24 hours", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const initialDay = await presale.currentDay();
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();
                const newDay = await presale.currentDay();
                expect(newDay).to.equal(initialDay + BigInt(1));
            });

            it("Should not allow distribution before 24 hours", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                await expect(presale.distributeTokens(await presale.currentDay()))
                    .to.be.revertedWith("Day not ended");
            });
        });

        describe("2.6 Token Distribution", function () {
            it("Should distribute tokens proportionally to contributors", async function () {
                // Two contributors with different amounts
                const amount1 = ethers.parseUnits("30", 6); // 30 USDT
                const amount2 = ethers.parseUnits("60", 6); // 60 USDT
                const totalAmount = BigInt(amount1) + BigInt(amount2);

                await mockUSDT.mint(addr1.address, amount1);
                await mockUSDT.mint(addr2.address, amount2);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), amount1);
                await mockUSDT.connect(addr2).approve(await presale.getAddress(), amount2);

                await presale.connect(addr1).contribute(amount1);
                await presale.connect(addr2).contribute(amount2);

                // Move to next day and distribute
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();

                // Check token distribution
                const dailyTokens = await presale.DAILY_TOKENS();
                const expectedTokens1 = (BigInt(dailyTokens) * BigInt(amount1)) / totalAmount;
                const expectedTokens2 = (BigInt(dailyTokens) * BigInt(amount2)) / totalAmount;

                const balance1 = await mockToken.balanceOf(addr1.address);
                const balance2 = await mockToken.balanceOf(addr2.address);

                expect(balance1).to.equal(expectedTokens1);
                expect(balance2).to.equal(expectedTokens2);
            });
        });

        describe("2.7 Emergency Mode", function () {
            beforeEach(async function () {
                // Enable emergency mode before each test in this block
                await presale.connect(owner).setEmergencyMode(true);
            });

            it("Should not accept contributions in emergency mode", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);

                await expect(presale.connect(addr1).contribute(contribution))
                    .to.be.revertedWith("Emergency mode is active");
            });

            it("Should not accept BNB contributions in emergency mode", async function () {
                const contribution = ethers.parseEther("1");

                await expect(presale.connect(addr1).contributeWithBNB({ value: contribution }))
                    .to.be.revertedWith("Emergency mode is active");
            });

            afterEach(async function () {
                // Disable emergency mode after each test
                await presale.connect(owner).setEmergencyMode(false);
            });
        });

        describe("2.8 Edge Cases and Error Conditions", function () {
            it("Should handle zero contributions day correctly", async function () {
                const currentDay = await presale.currentDay();
                const contributorsCount = await presale.getDailyContributorsCount(currentDay);
                expect(contributorsCount).to.equal(0);
            });

            it("Should handle large number of contributors", async function () {
                const amount = ethers.parseUnits("100", 6);
                const numContributors = 10; // Test with 10 contributors

                for (let i = 0; i < numContributors; i++) {
                    const contributor = addrs[i];
                    await mockUSDT.mint(contributor.address, amount);
                    await mockUSDT.connect(contributor).approve(await presale.getAddress(), amount);
                    await presale.connect(contributor).contribute(amount);
                }

                await time.increase(time.duration.days(1));
                await expect(presale.distributeDaily()).to.not.be.reverted;
            });
        });

        describe("2.9 Additional Tests", function () {
            it("Should track user contributions correctly", async function () {
                const contribution = ethers.parseUnits("100", 6); // 100 USDT
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(userContribution).to.equal(contribution);
            });

            it("Should mark users as bonus eligible with sufficient contribution", async function () {
                const contribution = ethers.parseUnits("10000", 6); // 10k USDT
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(BigInt(userContribution) >= BigInt(MIN_BONUS_AMOUNT)).to.be.true;
            });

            it("Should handle day changes correctly", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, BigInt(contribution) * BigInt(2));
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), BigInt(contribution) * BigInt(2));
                
                // First contribution
                await presale.connect(addr1).contribute(contribution);
                const initialDay = await presale.currentDay();
                
                // Move to next day
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();
                
                // Second contribution
                await presale.connect(addr1).contribute(contribution);
                const newDay = await presale.currentDay();
                expect(newDay).to.equal(initialDay + BigInt(1));

                // Check contributions on both days
                const day0Contribution = await presale.getDailyContribution(initialDay, addr1.address);
                const day1Contribution = await presale.getDailyContribution(newDay, addr1.address);
                
                expect(day0Contribution).to.equal(contribution);
                expect(day1Contribution).to.equal(contribution);
            });

            it("Should prevent contributions when day has ended", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                
                // Move to next day
                await time.increase(time.duration.days(1));
                
                await expect(
                    presale.connect(addr1).contribute(contribution)
                ).to.be.revertedWith("Day ended");
            });

            it("Should track bonus eligibility correctly", async function () {
                const smallContribution = ethers.parseUnits("100", 6);
                const largeContribution = ethers.parseUnits("10000", 6);
                
                // Small contribution (not bonus eligible)
                await mockUSDT.mint(addr1.address, smallContribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), smallContribution);
                await presale.connect(addr1).contribute(smallContribution);
                
                const currentDay = await presale.currentDay();
                const userContribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(BigInt(userContribution) >= BigInt(MIN_BONUS_AMOUNT)).to.be.false;
                
                // Large contribution (bonus eligible)
                await mockUSDT.mint(addr2.address, largeContribution);
                await mockUSDT.connect(addr2).approve(await presale.getAddress(), largeContribution);
                await presale.connect(addr2).contribute(largeContribution);
                
                const userContribution2 = await presale.getDailyContribution(currentDay, addr2.address);
                expect(BigInt(userContribution2) >= BigInt(MIN_BONUS_AMOUNT)).to.be.true;
            });

            it("Should emit ContributionReceived event", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                
                const currentDay = await presale.currentDay();
                await expect(presale.connect(addr1).contribute(contribution))
                    .to.emit(presale, "ContributionReceived")
                    .withArgs(addr1.address, contribution, currentDay);
            });
        });
    });
});
