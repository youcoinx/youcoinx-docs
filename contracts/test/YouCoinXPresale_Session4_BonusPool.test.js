const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("YouCoinXPresale", function () {
    // Constants for testing
    const DAILY_TOKENS = ethers.parseUnits("8990925", 18);
    const INITIAL_BONUS_POOL = ethers.parseUnits("820421968", 18);
    const MIN_BONUS_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDT
    const INITIAL_PRESALE_AMOUNT = ethers.parseUnits("4103108837.97", 18);
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
        await priceFeedProxy.setMockPrice(ethers.parseUnits("300", 8)); // $300 USD

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

        // Grant distributor role to owner
        await presale.grantRole(await presale.DISTRIBUTOR_ROLE(), owner.address);
    });

    describe("4. Bonus Pool Tests", function () {
        describe("4.1 Empty Bonus Pool Handling", function () {
            it("Should handle distribution when bonus pool is empty", async function () {
                // 1. Primeiro vamos esvaziar o pool de bônus
                const largeContribution = ethers.parseUnits("100000", 6); // 100k USDT
                const numContributors = 8;
                
                console.log("\nDistribuição inicial de tokens:");
                console.log(`Bonus Pool Inicial: ${ethers.formatUnits(await presale.bonusPool(), 18)} YCX`);
                
                // Fazer várias contribuições grandes
                for (let i = 0; i < numContributors; i++) {
                    const contributor = addrs[i];
                    await mockUSDT.mint(contributor.address, largeContribution);
                    await mockUSDT.connect(contributor).approve(await presale.getAddress(), largeContribution);
                    await presale.connect(contributor).contribute(largeContribution);
                }

                // Pegar o dia atual antes de avançar
                const contributionDay = await presale.currentDay();
                console.log(`\nDia das contribuições iniciais: ${contributionDay}`);

                // Avançar um dia e distribuir
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();

                console.log("\nApós primeira distribuição:");
                console.log(`Bonus Pool Restante: ${ethers.formatUnits(await presale.bonusPool(), 18)} YCX`);
                
                // Verificar tokens recebidos por cada contribuidor
                for (let i = 0; i < numContributors; i++) {
                    const contributor = addrs[i];
                    const tokensReceived = await mockToken.balanceOf(contributor.address);
                    const contribution = await presale.getDailyContribution(contributionDay, contributor.address);
                    console.log(`Contribuidor ${i + 1}:`);
                    console.log(`  Contribuição: ${ethers.formatUnits(contribution, 6)} USDT`);
                    console.log(`  Tokens Recebidos: ${ethers.formatUnits(tokensReceived, 18)} YCX`);
                }

                // 2. Fazer uma nova contribuição
                const newContribution = ethers.parseUnits("10000", 6); // 10k USDT
                await mockUSDT.mint(addr1.address, newContribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), newContribution);
                
                // A contribuição deve ser aceita mesmo com pool baixo
                await expect(presale.connect(addr1).contribute(newContribution))
                    .to.not.be.reverted;

                // Pegar o dia da nova contribuição
                const newContributionDay = await presale.currentDay();
                console.log(`\nDia da nova contribuição: ${newContributionDay}`);

                // Avançar mais um dia
                await time.increase(time.duration.days(1));

                // Distribuir tokens novamente
                await presale.distributeDaily();

                // Verificar tokens recebidos pelo novo contribuidor
                const newContributorTokens = await mockToken.balanceOf(addr1.address);
                console.log("\nNovo Contribuidor:");
                console.log(`  Contribuição: ${ethers.formatUnits(newContribution, 6)} USDT`);
                console.log(`  Tokens Recebidos: ${ethers.formatUnits(newContributorTokens, 18)} YCX`);
                console.log(`Bonus Pool Final: ${ethers.formatUnits(await presale.bonusPool(), 18)} YCX`);

                // Verificar se a distribuição foi marcada como concluída
                const wasDistributed = await presale.isDayDistributed(newContributionDay);
                expect(wasDistributed).to.be.true;

                // Verificar se a contribuição foi registrada corretamente
                const contribution = await presale.getDailyContribution(newContributionDay, addr1.address);
                expect(contribution).to.equal(newContribution);
            });

            it("Should distribute remaining bonus when pool is almost empty", async function () {
                // 1. Fazer várias contribuições grandes para reduzir significativamente o pool
                const contribution = ethers.parseUnits("10000", 6); // 10k USDT
                const numContributors = 5;
                
                // Registrar saldo inicial do pool
                const initialBonusPool = await presale.bonusPool();
                
                // Fazer contribuições
                for (let i = 0; i < numContributors; i++) {
                    const contributor = addrs[i];
                    await mockUSDT.mint(contributor.address, contribution);
                    await mockUSDT.connect(contributor).approve(await presale.getAddress(), contribution);
                    await presale.connect(contributor).contribute(contribution);
                }

                // Avançar um dia
                await time.increase(time.duration.days(1));

                // Distribuir tokens
                await presale.distributeDaily();

                // Verificar se o pool de bônus foi reduzido
                const finalBonusPool = await presale.bonusPool();
                expect(finalBonusPool).to.be.lt(initialBonusPool);

                // Verificar se ainda há bônus disponível
                expect(finalBonusPool).to.be.gt(0);
            });

            it("Should handle contribution correctly when bonus pool is depleted", async function () {
                // 1. Primeiro vamos reduzir significativamente o pool de bônus
                const largeContribution = ethers.parseUnits("100000", 6); // 100k USDT
                const numContributors = 8;
                
                // Fazer várias contribuições grandes
                for (let i = 0; i < numContributors; i++) {
                    const contributor = addrs[i];
                    await mockUSDT.mint(contributor.address, largeContribution);
                    await mockUSDT.connect(contributor).approve(await presale.getAddress(), largeContribution);
                    await presale.connect(contributor).contribute(largeContribution);
                }

                // Avançar um dia e distribuir
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();

                // 2. Fazer uma nova contribuição
                const newContribution = ethers.parseUnits("10000", 6); // 10k USDT
                await mockUSDT.mint(addr1.address, newContribution);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), newContribution);
                
                // A contribuição deve ser aceita mesmo com pool baixo/vazio
                await expect(presale.connect(addr1).contribute(newContribution))
                    .to.not.be.reverted;

                // Verificar se a contribuição foi registrada
                const currentDay = await presale.currentDay();
                const contribution = await presale.getDailyContribution(currentDay, addr1.address);
                expect(contribution).to.equal(newContribution);
            });

            it("Should show detailed token distribution for different contribution amounts", async function () {
                // Setup dos contribuidores com valores diferentes
                const contribution1 = ethers.parseUnits("100000", 6);  // 100k USDT
                const contribution2 = ethers.parseUnits("8000", 6);    // 8k USDT
                const contribution3 = ethers.parseUnits("50", 6);      // 50 USDT

                console.log("\nCONTRIBUIÇÕES INICIAIS:");
                console.log(`Contribuidor 1: ${ethers.formatUnits(contribution1, 6)} USDT`);
                console.log(`Contribuidor 2: ${ethers.formatUnits(contribution2, 6)} USDT`);
                console.log(`Contribuidor 3: ${ethers.formatUnits(contribution3, 6)} USDT`);

                // Registrar bonus pool inicial
                const initialBonusPool = await presale.bonusPool();
                console.log(`\nBonus Pool Inicial: ${ethers.formatUnits(initialBonusPool, 18)} YCX`);

                // Fazer as contribuições
                await mockUSDT.mint(addr1.address, contribution1);
                await mockUSDT.connect(addr1).approve(await presale.getAddress(), contribution1);
                await presale.connect(addr1).contribute(contribution1);

                await mockUSDT.mint(addr2.address, contribution2);
                await mockUSDT.connect(addr2).approve(await presale.getAddress(), contribution2);
                await presale.connect(addr2).contribute(contribution2);

                const contributor3 = addrs[0];
                await mockUSDT.mint(contributor3.address, contribution3);
                await mockUSDT.connect(contributor3).approve(await presale.getAddress(), contribution3);
                await presale.connect(contributor3).contribute(contribution3);

                // Registrar o dia das contribuições
                const contributionDay = await presale.currentDay();

                // Avançar um dia e distribuir
                await time.increase(time.duration.days(1));
                await presale.distributeDaily();

                // Verificar tokens recebidos por cada contribuidor
                const addr1Tokens = await mockToken.balanceOf(addr1.address);
                const addr2Tokens = await mockToken.balanceOf(addr2.address);
                const addr3Tokens = await mockToken.balanceOf(contributor3.address);

                // Calcular tokens base (sem bônus) para cada contribuição
                // Taxa base é DAILY_TOKENS dividido pelo total de USDT contribuído no dia
                const totalUSDTContributed = contribution1 + contribution2 + contribution3;
                const baseTokensPerUSDT = DAILY_TOKENS * BigInt(1e6) / totalUSDTContributed;
                
                const baseTokens1 = contribution1 * baseTokensPerUSDT / BigInt(1e6);
                const baseTokens2 = contribution2 * baseTokensPerUSDT / BigInt(1e6);
                const baseTokens3 = contribution3 * baseTokensPerUSDT / BigInt(1e6);

                // Calcular bônus recebido
                const bonus1 = addr1Tokens - baseTokens1;
                const bonus2 = addr2Tokens - baseTokens2;
                const bonus3 = addr3Tokens - baseTokens3;

                console.log("\nDISTRIBUIÇÃO DETALHADA:");
                
                console.log(`\nContribuidor 1 (${ethers.formatUnits(contribution1, 6)} USDT):`);
                console.log(`  Tokens Base: ${ethers.formatUnits(baseTokens1, 18)} YCX`);
                console.log(`  Tokens Bônus: ${ethers.formatUnits(bonus1, 18)} YCX`);
                console.log(`  Total Recebido: ${ethers.formatUnits(addr1Tokens, 18)} YCX`);

                console.log(`\nContribuidor 2 (${ethers.formatUnits(contribution2, 6)} USDT):`);
                console.log(`  Tokens Base: ${ethers.formatUnits(baseTokens2, 18)} YCX`);
                console.log(`  Tokens Bônus: ${ethers.formatUnits(bonus2, 18)} YCX`);
                console.log(`  Total Recebido: ${ethers.formatUnits(addr2Tokens, 18)} YCX`);

                console.log(`\nContribuidor 3 (${ethers.formatUnits(contribution3, 6)} USDT):`);
                console.log(`  Tokens Base: ${ethers.formatUnits(baseTokens3, 18)} YCX`);
                console.log(`  Tokens Bônus: ${ethers.formatUnits(bonus3, 18)} YCX`);
                console.log(`  Total Recebido: ${ethers.formatUnits(addr3Tokens, 18)} YCX`);

                // Verificar bonus pool final
                const finalBonusPool = await presale.bonusPool();
                console.log(`\nBonus Pool Final: ${ethers.formatUnits(finalBonusPool, 18)} YCX`);
                console.log(`Bonus Pool Redução: ${ethers.formatUnits(initialBonusPool - finalBonusPool, 18)} YCX`);

                // Mostrar totais
                const totalBaseTokens = baseTokens1 + baseTokens2 + baseTokens3;
                const totalBonus = bonus1 + bonus2 + bonus3;
                console.log(`\nTOTAIS:`);
                console.log(`Total Base Distribuído: ${ethers.formatUnits(totalBaseTokens, 18)} YCX`);
                console.log(`Total Bônus Distribuído: ${ethers.formatUnits(totalBonus, 18)} YCX`);
            });
        });
    });
});
