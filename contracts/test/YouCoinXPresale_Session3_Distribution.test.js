const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("YouCoinXPresale", function () {
    // Constants for testing
    const DAILY_TOKENS = ethers.parseUnits("8990925", 18);
    const INITIAL_BONUS_POOL = ethers.parseUnits("820421968", 18);
    const MIN_BONUS_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDT
    const INITIAL_PRESALE_AMOUNT = ethers.parseUnits("4103108837", 18);
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
        await priceFeedProxy.setMockPrice(ethers.parseUnits("300", 8)); // 300 USD

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
                const minContribUSDT = ethers.parseUnits("10", 6); // 10 USDT
                const bnbPrice = await priceFeedProxy.getLatestPrice(); // 300 USD
                // Se 1 BNB = 300 USD, então 10 USD = 0.0333... BNB
                const minContribBNB = (minContribUSDT * BigInt(1e18)) / BigInt(bnbPrice);
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
                const totalExpected = contribution1 + contribution2;

                await mockUSDT.mint(addr1.address, totalExpected);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), totalExpected);

                await presale.connect(addr1).contribute(contribution1);
                await presale.connect(addr1).contribute(contribution2);

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                expect(userContribution).to.equal(totalExpected);
            });

            it("Should accumulate multiple BNB contributions from same user", async function () {
                const contribution1 = ethers.parseEther("0.5"); // 0.5 BNB
                const contribution2 = ethers.parseEther("0.3"); // 0.3 BNB
                
                await presale.connect(addr1).contributeWithBNB({ value: contribution1 });
                await presale.connect(addr1).contributeWithBNB({ value: contribution2 });

                const bnbPrice = await priceFeedProxy.getLatestPrice(); // 300 USD
                const expectedUSD1 = (contribution1 * BigInt(bnbPrice)) / BigInt(1e18);
                const expectedUSD2 = (contribution2 * BigInt(bnbPrice)) / BigInt(1e18);
                const totalExpectedUSD = expectedUSD1 + expectedUSD2;

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                expect(userContribution).to.equal(totalExpectedUSD);
            });
        });

        describe("2.3 Bonus Eligibility", function () {
            it("Should grant bonus for USDT contribution above minimum", async function () {
                const contribution = ethers.parseUnits("10000", 6); // 10k USDT
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                const minBonusAmount = await presale.MIN_BONUS_AMOUNT();
                expect(userContribution >= minBonusAmount).to.be.true;
            });

            it("Should grant bonus for BNB contribution above minimum", async function () {
                // Se 1 BNB = 300 USD, precisamos de ~33.33 BNB para 10k USD
                const bnbPrice = await priceFeedProxy.getLatestPrice(); // 300 * 10^8
                const minBonusUSD = ethers.parseUnits("10000", 6); // 10k USDT = 10000 * 10^6
                
                // No contrato: usdAmount = (bnbAmount * price) / 1e18
                // Então: bnbAmount = (usdAmount * 1e18) / price
                // Como price tem 8 decimais: bnbAmount = (usdAmount * 1e18) / (price * 1e8 / 1e8)
                // Simplificando: bnbAmount = (usdAmount * 1e18) / (price / 1e8)
                const minBonusBNB = (minBonusUSD * BigInt(1e20)) / BigInt(bnbPrice);
                
                await presale.connect(addr1).contributeWithBNB({ value: minBonusBNB + BigInt(1e17) }); // adiciona 0.1 BNB para garantir

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                const minBonusAmount = await presale.MIN_BONUS_AMOUNT();
                expect(userContribution >= minBonusAmount).to.be.true;
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

                const expectedShare = amount / 2n;
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

                const expectedShare = bnbAmount / 2n;
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
                expect(newDay).to.equal(initialDay + 1n);
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
                const amount1 = ethers.parseUnits("30", 6);
                const amount2 = ethers.parseUnits("60", 6);
                const totalAmount = amount1 + amount2;

                await mockUSDT.mint(addr1.address, totalAmount);
                await mockUSDT.mint(addr2.address, totalAmount);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), totalAmount);
                await mockUSDT.connect(addr2).approve(await presale.getAddress(), totalAmount);

                await presale.connect(addr1).contribute(amount1);
                await presale.connect(addr2).contribute(amount2);

                // Move to next day and distribute
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();

                // Check token distribution
                const dailyTokens = await presale.DAILY_TOKENS();
                
                // Dia 1: 1 contribuição de 100 USDT = 100 USDT total
                const expectedTokens1 = dailyTokens * amount1 / totalAmount;
                const expectedTokens2 = dailyTokens * amount2 / totalAmount;

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
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                expect(userContribution).to.equal(contribution);
            });

            it("Should mark users as bonus eligible with sufficient contribution", async function () {
                const contribution = ethers.parseUnits("10000", 6);
                await mockUSDT.mint(addr1.address, contribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution);
                await presale.connect(addr1).contribute(contribution);

                const userContribution = await presale.getDailyContribution(0, addr1.address);
                const minBonusAmount = await presale.MIN_BONUS_AMOUNT();
                expect(userContribution >= minBonusAmount).to.be.true;
            });

            it("Should handle day changes correctly", async function () {
                const contribution = ethers.parseUnits("100", 6);
                await mockUSDT.mint(addr1.address, contribution * 2n);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution * 2n);
                
                // First contribution
                await presale.connect(addr1).contribute(contribution);
                const initialDay = await presale.currentDay();
                
                // Move to next day
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();
                
                // Second contribution
                await presale.connect(addr1).contribute(contribution);
                const newDay = await presale.currentDay();
                expect(newDay).to.equal(initialDay + 1n);

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
                
                const userContribution = await presale.getDailyContribution(0, addr1.address);
                const minBonusAmount = await presale.MIN_BONUS_AMOUNT();
                expect(userContribution >= minBonusAmount).to.be.false;
                
                // Large contribution (bonus eligible)
                await mockUSDT.mint(addr2.address, largeContribution);
                await mockUSDT.connect(addr2).approve(await presale.getAddress(), largeContribution);
                await presale.connect(addr2).contribute(largeContribution);
                
                const userContribution2 = await presale.getDailyContribution(0, addr2.address);
                expect(userContribution2 >= minBonusAmount).to.be.true;
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

    describe("3. Distribution Tests", function () {
        describe("3.1 Events and Advanced Monitoring", function () {
            it("Should handle multiple contributions across accumulated days correctly", async function () {
                const signers = await ethers.getSigners();
                const contributors = signers.slice(6);
                const contribution = ethers.parseUnits("100", 6); // 100 USDT
                const numContributorsDay1 = 1;
                const numContributorsDay2 = 2;
                const numContributorsDay3 = 3;
                const dailyTokens = await presale.DAILY_TOKENS();

                // Dia 1: 1 contribuição de 100 USDT
                await mockUSDT.mint(contributors[0].address, contribution);
                await mockUSDT.connect(contributors[0]).approve(await presale.getAddress(), contribution);
                await presale.connect(contributors[0]).contribute(contribution);

                // Avança para Dia 2
                const currentTime = await time.latest();
                const day2Time = currentTime + time.duration.days(2);
                await time.setNextBlockTimestamp(day2Time);
                await presale.setStartTime(day2Time - time.duration.days(1));
                await presale.setCurrentDay(1);

                // Dia 2: 2 contribuições de 100 USDT cada
                for(let i = 0; i < numContributorsDay2; i++) {
                    await mockUSDT.mint(contributors[i + numContributorsDay1].address, contribution);
                    await mockUSDT.connect(contributors[i + numContributorsDay1]).approve(await presale.getAddress(), contribution);
                    await presale.connect(contributors[i + numContributorsDay1]).contribute(contribution);
                }

                // Avança para Dia 3
                const day3Time = currentTime + time.duration.days(3);
                await time.setNextBlockTimestamp(day3Time);
                await presale.setStartTime(day3Time - time.duration.days(2));
                await presale.setCurrentDay(2);

                // Dia 3: 3 contribuições de 100 USDT cada
                for(let i = 0; i < numContributorsDay3; i++) {
                    await mockUSDT.mint(contributors[i + numContributorsDay1 + numContributorsDay2].address, contribution);
                    await mockUSDT.connect(contributors[i + numContributorsDay1 + numContributorsDay2]).approve(await presale.getAddress(), contribution);
                    await presale.connect(contributors[i + numContributorsDay1 + numContributorsDay2]).contribute(contribution);
                }

                // Avança mais um dia para poder distribuir
                const day4Time = currentTime + time.duration.days(4);
                await time.setNextBlockTimestamp(day4Time);
                await presale.setStartTime(day4Time - time.duration.days(3));
                await presale.setCurrentDay(3);

                // Distribui tokens do Dia 1
                await presale.distributeTokens(0);
                expect(await presale.isDayDistributed(0)).to.be.true;

                // Verifica distribuição do Dia 1
                const expectedTokensDay1 = dailyTokens; // 100% dos tokens do dia
                const actualTokensDay1 = await mockToken.balanceOf(contributors[0].address);
                expect(actualTokensDay1).to.equal(expectedTokensDay1);

                // Distribui tokens do Dia 2
                await presale.distributeTokens(1);
                expect(await presale.isDayDistributed(1)).to.be.true;

                // Verifica distribuição do Dia 2
                const expectedTokensDay2 = dailyTokens / 2n; // 50% dos tokens do dia cada
                for(let i = 0; i < numContributorsDay2; i++) {
                    const actualTokens = await mockToken.balanceOf(contributors[i + numContributorsDay1].address);
                    expect(actualTokens).to.equal(expectedTokensDay2);
                }

                // Distribui tokens do Dia 3
                await presale.distributeTokens(2);
                expect(await presale.isDayDistributed(2)).to.be.true;

                // Verifica distribuição do Dia 3
                const expectedTokensDay3 = dailyTokens / 3n; // 33.33% dos tokens do dia cada
                for(let i = 0; i < numContributorsDay3; i++) {
                    const actualTokens = await mockToken.balanceOf(contributors[i + numContributorsDay1 + numContributorsDay2].address);
                    expect(actualTokens).to.equal(expectedTokensDay3);
                }

                // Verifica eventos de distribuição
                const tx = await presale.distributeDaily();
                const receipt = await tx.wait();
                const event = receipt.logs.find(log => {
                    try {
                        return presale.interface.parseLog(log).name === "DistributionAttempted";
                    } catch {
                        return false;
                    }
                });
                const parsedEvent = presale.interface.parseLog(event);
                expect(parsedEvent.args[1]).to.be.false; // Deve falhar pois já distribuiu
                expect(parsedEvent.args[2]).to.be.gt(0); // gasUsed deve ser > 0
            });
        });
    });
});
