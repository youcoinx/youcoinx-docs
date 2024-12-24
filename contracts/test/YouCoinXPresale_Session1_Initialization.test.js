const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("YouCoinXPresale", function () {
    // Constantes para teste
    const DAILY_TOKENS = ethers.parseEther("8990925");
    const INITIAL_BONUS_POOL = ethers.parseEther("820421968");
    const MIN_BONUS_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDT
    const INITIAL_PRESALE_AMOUNT = ethers.parseEther("4103108837.97");
    const INITIAL_USDT_SUPPLY = ethers.parseUnits("1000000", 6); // 1M USDT

    // Variáveis de contrato e contas
    let YouCoinX;
    let youCoinX;
    let YouCoinXPresale;
    let presale;
    let PriceFeedProxy;
    let priceFeedProxy;
    let owner;
    let addr1;
    let addr2;
    let addr3;
    let addrs;
    let mockUSDT;

    beforeEach(async function () {
        console.log("Starting test setup...");
        
        // Get signers
        [owner, addr1, addr2, addr3, ...addrs] = await ethers.getSigners();
        console.log("Got signers. Owner address:", owner.address);

        try {
            // Deploy mock USDT
            console.log("Deploying MockERC20...");
            const MockToken = await ethers.getContractFactory("MockERC20");
            mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 6);
            await mockUSDT.waitForDeployment();
            console.log("MockERC20 deployed at:", await mockUSDT.getAddress());
            
            // Mint initial USDT supply
            await mockUSDT.mint(owner.address, INITIAL_USDT_SUPPLY);
            console.log("Minted initial USDT supply");

            // Deploy YouCoinX token
            console.log("Deploying YouCoinX...");
            YouCoinX = await ethers.getContractFactory("YouCoinX");
            youCoinX = await upgrades.deployProxy(YouCoinX, [
                addr1.address, // presale wallet
                addr2.address, // liquidity wallet
                addr3.address, // rewards pool wallet
                owner.address  // operational wallet
            ], { kind: 'uups' });
            await youCoinX.waitForDeployment();
            console.log("YouCoinX deployed at:", await youCoinX.getAddress());

            // Deploy PriceFeedProxy
            console.log("Deploying PriceFeedProxy...");
            PriceFeedProxy = await ethers.getContractFactory("PriceFeedProxy");
            priceFeedProxy = await upgrades.deployProxy(PriceFeedProxy, [], { kind: 'uups' });
            await priceFeedProxy.waitForDeployment();
            console.log("PriceFeedProxy deployed at:", await priceFeedProxy.getAddress());

            // Set mock price in PriceFeedProxy (300 USD per BNB)
            await priceFeedProxy.setMockPrice(ethers.parseUnits("300", 8));
            console.log("Set mock price in PriceFeedProxy");

            // Deploy YouCoinXPresale
            console.log("Deploying YouCoinXPresale...");
            YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
            
            const youCoinXAddress = await youCoinX.getAddress();
            const mockUSDTAddress = await mockUSDT.getAddress();
            const priceFeedProxyAddress = await priceFeedProxy.getAddress();
            
            console.log("Deployment parameters:");
            console.log("- YouCoinX address:", youCoinXAddress);
            console.log("- USDT address:", mockUSDTAddress);
            console.log("- Liquidity wallet:", addr2.address);
            console.log("- Operational wallet:", owner.address);
            console.log("- PriceFeedProxy address:", priceFeedProxyAddress);
            
            presale = await upgrades.deployProxy(YouCoinXPresale, [
                youCoinXAddress,
                mockUSDTAddress,
                addr2.address,
                owner.address,
                priceFeedProxyAddress
            ], { kind: 'uups' });
            await presale.waitForDeployment();
            const presaleAddress = await presale.getAddress();
            console.log("YouCoinXPresale deployed at:", presaleAddress);

            // Transfer presale tokens to the presale contract
            await youCoinX.connect(addr1).transfer(presaleAddress, INITIAL_PRESALE_AMOUNT);
            console.log("Transferred presale tokens");

            // Register presale contract as module in YouCoinX
            await youCoinX.registerModule(presaleAddress);
            console.log("Registered presale as module");
            
        } catch (error) {
            console.error("Error in setup:", error);
            throw error;
        }
    });

    describe("1. Initialization Tests", function () {
        describe("1.1 Token Addresses", function () {
            it("Should initialize with correct YouCoinX token address", async function () {
                const expectedAddress = await youCoinX.getAddress();
                const actualAddress = await presale.token();
                console.log("YouCoinX address comparison:");
                console.log("Expected:", expectedAddress);
                console.log("Actual:", actualAddress);
                expect(actualAddress).to.equal(expectedAddress);
            });

            it("Should initialize with correct USDT token address", async function () {
                expect(await presale.usdt()).to.equal(await mockUSDT.getAddress());
            });

            it("Should initialize with correct price feed address", async function () {
                expect(await presale.priceFeedProxy()).to.equal(await priceFeedProxy.getAddress());
            });

            it("Should have correct token balance after initialization", async function () {
                const balance = await youCoinX.balanceOf(await presale.getAddress());
                expect(balance).to.equal(INITIAL_PRESALE_AMOUNT);
            });

            it("Should be registered as a module in YouCoinX", async function () {
                expect(await youCoinX.registeredModules(await presale.getAddress())).to.be.true;
            });
        });

        describe("1.2 Initial State", function () {
            it("Should initialize with correct initial state values", async function () {
                expect(await presale.currentDay()).to.equal(0);
                expect(await presale.bonusPool()).to.equal(INITIAL_BONUS_POOL);
                
                const startTime = await presale.startTime();
                expect(startTime).to.not.equal(0);
                expect(startTime).to.be.closeTo(
                    await time.latest(),
                    5 // permitindo diferença de 5 segundos
                );
            });
        });

        describe("1.3 Wallet Addresses", function () {
            it("Should initialize with correct liquidity wallet", async function () {
                expect(await presale.liquidityWallet()).to.equal(addr2.address);
            });

            it("Should initialize with correct operational wallet", async function () {
                expect(await presale.operationalWallet()).to.equal(owner.address);
            });
        });

        describe("1.4 Initial Constants", function () {
            it("Should have correct daily tokens amount", async function () {
                expect(await presale.DAILY_TOKENS()).to.equal(DAILY_TOKENS);
            });

            it("Should have correct initial bonus pool", async function () {
                expect(await presale.INITIAL_BONUS_POOL()).to.equal(INITIAL_BONUS_POOL);
            });

            it("Should have correct minimum bonus amount", async function () {
                expect(await presale.MIN_BONUS_AMOUNT()).to.equal(MIN_BONUS_AMOUNT);
            });
        });

        describe("1.5 Zero Address Validations", function () {
            it("Should revert when initializing with zero YouCoinX address", async function () {
                const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
                await expect(upgrades.deployProxy(YouCoinXPresale, [
                    ethers.ZeroAddress,
                    await mockUSDT.getAddress(),
                    addr2.address,
                    owner.address,
                    await priceFeedProxy.getAddress()
                ], { kind: 'uups' })).to.be.revertedWith("Invalid token address");
            });

            it("Should revert when initializing with zero USDT address", async function () {
                const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
                await expect(upgrades.deployProxy(YouCoinXPresale, [
                    await youCoinX.getAddress(),
                    ethers.ZeroAddress,
                    addr2.address,
                    owner.address,
                    await priceFeedProxy.getAddress()
                ], { kind: 'uups' })).to.be.revertedWith("Invalid USDT address");
            });

            it("Should revert when initializing with zero liquidity wallet", async function () {
                const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
                await expect(upgrades.deployProxy(YouCoinXPresale, [
                    await youCoinX.getAddress(),
                    await mockUSDT.getAddress(),
                    ethers.ZeroAddress,
                    owner.address,
                    await priceFeedProxy.getAddress()
                ], { kind: 'uups' })).to.be.revertedWith("Invalid liquidity wallet");
            });

            it("Should revert when initializing with zero operational wallet", async function () {
                const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
                await expect(upgrades.deployProxy(YouCoinXPresale, [
                    await youCoinX.getAddress(),
                    await mockUSDT.getAddress(),
                    addr2.address,
                    ethers.ZeroAddress,
                    await priceFeedProxy.getAddress()
                ], { kind: 'uups' })).to.be.revertedWith("Invalid operational wallet");
            });

            it("Should revert when initializing with zero price feed proxy", async function () {
                const YouCoinXPresale = await ethers.getContractFactory("YouCoinXPresale");
                await expect(upgrades.deployProxy(YouCoinXPresale, [
                    await youCoinX.getAddress(),
                    await mockUSDT.getAddress(),
                    addr2.address,
                    owner.address,
                    ethers.ZeroAddress
                ], { kind: 'uups' })).to.be.revertedWith("Invalid price feed proxy");
            });
        });

        describe("1.6 Price Feed Connection", function () {
            it("Should get correct BNB price from price feed", async function () {
                const mockPrice = ethers.parseUnits("300", 8); // $300 USD
                await priceFeedProxy.setMockPrice(mockPrice);
                
                // Test 1: 1 BNB = $300
                const bnbAmount1 = ethers.parseEther("1"); // 1 BNB
                const expectedUsd1 = ethers.parseUnits("300", 8); // $300 USD
                const actualUsd1 = await presale.getBNBInUSD(bnbAmount1);
                expect(actualUsd1).to.equal(expectedUsd1);

                // Test 2: 0.5 BNB = $150
                const bnbAmount2 = ethers.parseEther("0.5"); // 0.5 BNB
                const expectedUsd2 = ethers.parseUnits("150", 8); // $150 USD
                const actualUsd2 = await presale.getBNBInUSD(bnbAmount2);
                expect(actualUsd2).to.equal(expectedUsd2);

                // Test 3: 1.337 BNB = $401.10
                const bnbAmount3 = ethers.parseEther("1.337"); // 1.337 BNB
                const expectedUsd3 = ethers.parseUnits("401.1", 8); // $401.10 USD
                const actualUsd3 = await presale.getBNBInUSD(bnbAmount3);
                expect(actualUsd3).to.equal(expectedUsd3);
            });

            it("Should use correct price feed address", async function () {
                const expectedFeed = await priceFeedProxy.getAddress();
                const actualFeed = await presale.priceFeedProxy();
                expect(actualFeed).to.equal(expectedFeed);
            });

            it("Should handle price feed updates correctly", async function () {
                const initialPrice = ethers.parseUnits("300", 8); // $300
                const newPrice = ethers.parseUnits("350", 8);    // $350
                const bnbAmount = ethers.parseEther("2.5");      // 2.5 BNB
                
                await priceFeedProxy.setMockPrice(initialPrice);
                let usdAmount = await presale.getBNBInUSD(bnbAmount);
                expect(usdAmount).to.equal(ethers.parseUnits("750", 8)); // 2.5 BNB * $300 = $750
                
                await priceFeedProxy.setMockPrice(newPrice);
                usdAmount = await presale.getBNBInUSD(bnbAmount);
                expect(usdAmount).to.equal(ethers.parseUnits("875", 8)); // 2.5 BNB * $350 = $875
            });

            it("Should handle very small BNB amounts correctly", async function () {
                const mockPrice = ethers.parseUnits("300", 8); // $300 USD
                await priceFeedProxy.setMockPrice(mockPrice);
                
                // Test with 0.0001 BNB
                const smallAmount = ethers.parseEther("0.0001"); // 0.0001 BNB
                const expectedUsd = ethers.parseUnits("0.03", 8); // $0.03 USD (0.0001 * $300)
                const actualUsd = await presale.getBNBInUSD(smallAmount);
                expect(actualUsd).to.equal(expectedUsd);
            });
        });

        describe("1.7 Role and Access Control", function () {
            it("Should grant DISTRIBUTOR_ROLE to owner on initialization", async function () {
                const DISTRIBUTOR_ROLE = await presale.DISTRIBUTOR_ROLE();
                expect(await presale.hasRole(DISTRIBUTOR_ROLE, owner.address)).to.be.true;
            });

            it("Should allow owner to grant DISTRIBUTOR_ROLE", async function () {
                const DISTRIBUTOR_ROLE = await presale.DISTRIBUTOR_ROLE();
                await presale.setDistributor(addr1.address, true);
                expect(await presale.hasRole(DISTRIBUTOR_ROLE, addr1.address)).to.be.true;
            });

            it("Should allow owner to revoke DISTRIBUTOR_ROLE", async function () {
                const DISTRIBUTOR_ROLE = await presale.DISTRIBUTOR_ROLE();
                await presale.setDistributor(addr1.address, true);
                await presale.setDistributor(addr1.address, false);
                expect(await presale.hasRole(DISTRIBUTOR_ROLE, addr1.address)).to.be.false;
            });
        });

        describe("1.8 Emergency Mode", function () {
            it("Should initialize with emergency mode disabled", async function () {
                expect(await presale.emergencyMode()).to.be.false;
            });

            it("Should allow owner to enable emergency mode", async function () {
                await expect(presale.setEmergencyMode(true))
                    .to.emit(presale, "EmergencyModeChanged")
                    .withArgs(true);
                expect(await presale.emergencyMode()).to.be.true;
            });

            it("Should allow owner to disable emergency mode", async function () {
                await presale.setEmergencyMode(true);
                await expect(presale.setEmergencyMode(false))
                    .to.emit(presale, "EmergencyModeChanged")
                    .withArgs(false);
                expect(await presale.emergencyMode()).to.be.false;
            });

            it("Should revert when non-owner tries to set emergency mode", async function () {
                await expect(presale.connect(addr1).setEmergencyMode(true))
                    .to.be.reverted;
            });
        });
    });
});
