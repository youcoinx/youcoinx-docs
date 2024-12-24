// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./PriceFeedProxy.sol";
import "./YouCoinX.sol";

/**
 * @title YouCoinXPresale
 * @dev Contrato de pré-venda do YouCoinX com distribuição diária e sistema de bônus
 */
contract YouCoinXPresale is UUPSUpgradeable, OwnableUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using Math for uint256;

    // Roles
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    
    // Estruturas
    struct DailyStats {
        uint256 totalContributions;
        mapping(address => uint256) contributions;
        bool distributed;
        address[] contributors;
        mapping(address => bool) hasContributed;
    }

    // Tokens
    YouCoinX public token;
    IERC20 public usdt;
    
    // Carteiras
    address public liquidityWallet;
    address public operationalWallet;
    
    // Oracle
    PriceFeedProxy public priceFeedProxy;
    
    // Estado do Contrato
    mapping(uint256 => DailyStats) public dailyStats;
    uint256 public currentDay;
    uint256 public bonusPool;
    uint256 public startTime;
    bool public emergencyMode;
    
    // Constantes
    uint256 public constant DAILY_TOKENS = 8_990_925 * 10**18;
    uint256 public constant INITIAL_BONUS_POOL = 820_421_968 * 10**18;
    uint256 public constant MIN_BONUS_AMOUNT = 10_000 * 10**6; // 10k USD em USDT (6 decimais)
    uint256 public constant MIN_CONTRIBUTION = 10 * 10**6; // 10 USDT
    
    // Eventos
    event ContributionReceived(address indexed user, uint256 amount, uint256 day);
    event TokensDistributed(address indexed user, uint256 baseAmount, uint256 bonusAmount);
    event FundsDistributed(uint256 liquidityAmount, uint256 operationalAmount);
    event UpgradeAuthorized(address newImplementation);
    event BonusPoolWithdrawn(address destination, uint256 amount);
    event DistributionAttempted(uint256 day, bool success, uint256 gasUsed);
    event DistributionFailed(uint256 day, string reason);
    event EmergencyModeChanged(bool enabled);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Inicializa o contrato
     */
    function initialize(
        address _token,
        address _usdt,
        address _liquidityWallet,
        address _operationalWallet,
        address _priceFeedProxy
    ) public initializer {
        __UUPSUpgradeable_init();
        __Ownable_init(msg.sender);
        __AccessControl_init();
        __ReentrancyGuard_init();

        require(_token != address(0), "Invalid token address");
        require(_usdt != address(0), "Invalid USDT address");
        require(_liquidityWallet != address(0), "Invalid liquidity wallet");
        require(_operationalWallet != address(0), "Invalid operational wallet");
        require(_priceFeedProxy != address(0), "Invalid price feed proxy");

        token = YouCoinX(_token);
        usdt = IERC20(_usdt);
        liquidityWallet = _liquidityWallet;
        operationalWallet = _operationalWallet;
        priceFeedProxy = PriceFeedProxy(_priceFeedProxy);
        
        currentDay = 0;
        bonusPool = INITIAL_BONUS_POOL;
        startTime = block.timestamp;
        emergencyMode = false;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(DISTRIBUTOR_ROLE, msg.sender);
    }

    /**
     * @dev Permite ao owner adicionar/remover distribuidores
     */
    function setDistributor(address distributor, bool enabled) external onlyOwner {
        if (enabled) {
            grantRole(DISTRIBUTOR_ROLE, distributor);
        } else {
            revokeRole(DISTRIBUTOR_ROLE, distributor);
        }
    }

    /**
     * @dev Ativa/desativa modo de emergência
     */
    function setEmergencyMode(bool enabled) external onlyOwner {
        emergencyMode = enabled;
        emit EmergencyModeChanged(enabled);
    }

    /**
     * @dev Converte BNB para USD
     */
    function getBNBInUSD(uint256 bnbAmount) public view returns (uint256) {
        int256 price = priceFeedProxy.getLatestPrice();
        require(price > 0, "Invalid price feed");
        return (bnbAmount * uint256(price)) / 1e18;
    }

    /**
     * @dev Contribuição em BNB
     */
    function contributeWithBNB() public payable nonReentrant {
        uint256 usdAmount = getBNBInUSD(msg.value);
        _contribute(usdAmount, false);
    }

    /**
     * @dev Recebe BNB
     */
    receive() external payable {
        contributeWithBNB();
    }

    /**
     * @dev Contribuição em USDT
     */
    function contribute(uint256 amount) external nonReentrant {
        _contribute(amount, true);
    }

    /**
     * @dev Lógica interna de contribuição
     */
    function _contribute(uint256 usdAmount, bool isUSDT) private {
        require(!emergencyMode, "Emergency mode is active");
        uint256 day = (block.timestamp - startTime) / 1 days;
        require(day == currentDay, "Day ended");
        
        // Validação de contribuição mínima
        require(usdAmount >= MIN_CONTRIBUTION, "Min contribution is 10 USDT");
        
        // Registrar contribuição
        if (!dailyStats[day].hasContributed[msg.sender]) {
            dailyStats[day].contributors.push(msg.sender);
            dailyStats[day].hasContributed[msg.sender] = true;
        }
        
        dailyStats[day].contributions[msg.sender] += usdAmount;
        dailyStats[day].totalContributions += usdAmount;
        
        // Distribuir fundos 50/50
        if (isUSDT) {
            require(usdt.transferFrom(msg.sender, address(this), usdAmount), "USDT transfer failed");
            _distributeUSDT(usdAmount);
        } else {
            _distributeBNB(msg.value);
        }
        
        emit ContributionReceived(msg.sender, usdAmount, day);
    }

    /**
     * @dev Distribuição diária de tokens - apenas distribuidor autorizado
     */
    function distributeDaily() external {
        require(
            hasRole(DISTRIBUTOR_ROLE, msg.sender) || (emergencyMode && msg.sender == owner()),
            "Caller is not authorized"
        );

        uint256 gasStart = gasleft();
        uint256 previousDay = currentDay;
        
        try this.distributeTokens(previousDay) {
            uint256 gasUsed = gasStart - gasleft();
            emit DistributionAttempted(previousDay, true, gasUsed);
        } catch Error(string memory reason) {
            emit DistributionFailed(previousDay, reason);
            uint256 gasUsed = gasStart - gasleft();
            emit DistributionAttempted(previousDay, false, gasUsed);
        } catch (bytes memory) {
            emit DistributionFailed(previousDay, "Unknown error");
            uint256 gasUsed = gasStart - gasleft();
            emit DistributionAttempted(previousDay, false, gasUsed);
        }
    }

    /**
     * @dev Distribui tokens para contribuidores do dia
     * @param day Dia para distribuir tokens
     */
    function distributeTokens(uint256 day) external nonReentrant {
        require(day < currentDay || (block.timestamp - startTime) / 1 days > currentDay, "Day not ended");
        require(!dailyStats[day].distributed, "Already distributed");
        require(dailyStats[day].totalContributions > 0, "No contributions");

        address[] memory contributors = _getContributors(day);
        uint256 totalContributions = dailyStats[day].totalContributions;
        
        for (uint256 i = 0; i < contributors.length; i++) {
            address contributor = contributors[i];
            uint256 contribution = dailyStats[day].contributions[contributor];
            
            // Calcula tokens base proporcionalmente
            uint256 baseTokens = DAILY_TOKENS.mulDiv(contribution, totalContributions);
            uint256 bonusTokens = 0;
            
            // Calcula bônus se aplicável (contribuição >= 10k USD)
            if (contribution >= MIN_BONUS_AMOUNT && bonusPool > 0) {
                bonusTokens = (baseTokens * 10) / 100; // 10% bônus
                
                // Ajusta se bônus exceder pool disponível
                if (bonusTokens > bonusPool) {
                    bonusTokens = bonusPool;
                }
                bonusPool -= bonusTokens;
            }
            
            // Transfere tokens
            require(token.transfer(contributor, baseTokens + bonusTokens), "Transfer failed");
            
            emit TokensDistributed(contributor, baseTokens, bonusTokens);
        }
        
        dailyStats[day].distributed = true;
        
        // Update current day after successful distribution
        uint256 newDay = (block.timestamp - startTime) / 1 days;
        if (newDay > currentDay) {
            currentDay = newDay;
        }
    }

    /**
     * @dev Verifica se um dia específico já teve seus tokens distribuídos
     */
    function isDayDistributed(uint256 day) external view returns (bool) {
        return dailyStats[day].distributed;
    }

    /**
     * @dev Retorna a contribuição de um endereço em um dia específico
     */
    function getDailyContribution(uint256 day, address contributor) external view returns (uint256) {
        return dailyStats[day].contributions[contributor];
    }

    /**
     * @dev Retorna o número de contribuidores de um dia específico
     */
    function getDailyContributorsCount(uint256 day) external view returns (uint256) {
        return dailyStats[day].contributors.length;
    }

    /**
     * @dev Retorna contribuidores de um dia específico com paginação
     */
    function getDailyContributors(uint256 day, uint256 offset, uint256 limit) 
        external 
        view 
        returns (address[] memory contributors, uint256 total) 
    {
        address[] storage dayContributors = dailyStats[day].contributors;
        total = dayContributors.length;
        
        if (offset >= total || limit == 0) {
            return (new address[](0), total);
        }
        
        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }
        
        uint256 size = end - offset;
        contributors = new address[](size);
        
        for (uint256 i = 0; i < size; i++) {
            contributors[i] = dayContributors[offset + i];
        }
        
        return (contributors, total);
    }

    /**
     * @dev Distribuição de USDT
     */
    function _distributeUSDT(uint256 amount) private {
        uint256 half = amount / 2;
        require(usdt.transfer(liquidityWallet, half), "Liquidity transfer failed");
        require(usdt.transfer(operationalWallet, amount - half), "Operational transfer failed");
        emit FundsDistributed(half, amount - half);
    }

    /**
     * @dev Distribuição de BNB
     */
    function _distributeBNB(uint256 amount) private {
        uint256 half = amount / 2;
        (bool sent1,) = liquidityWallet.call{value: half}("");
        (bool sent2,) = operationalWallet.call{value: amount - half}("");
        require(sent1 && sent2, "BNB transfer failed");
        emit FundsDistributed(half, amount - half);
    }

    /**
     * @dev Obtém lista de contribuidores do dia
     */
    function _getContributors(uint256 day) private view returns (address[] memory) {
        return dailyStats[day].contributors;
    }

    /**
     * @dev Autoriza upgrade do contrato
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        emit UpgradeAuthorized(newImplementation);
    }

    /**
     * @dev Resgata tokens não utilizados do pool de bônus
     * @param destination Endereço que receberá os tokens
     */
    function withdrawRemainingBonus(address destination) external onlyOwner {
        require(block.timestamp >= startTime + 365 days, "Presale not ended");
        require(destination != address(0), "Invalid destination");
        
        uint256 remainingBonus = bonusPool;
        require(remainingBonus > 0, "No bonus remaining");
        
        bonusPool = 0;
        require(token.transfer(destination, remainingBonus), "Transfer failed");
        
        emit BonusPoolWithdrawn(destination, remainingBonus);
    }

    /**
     * @dev Função para testes - permite definir o dia atual
     */
    function setCurrentDay(uint256 _day) external onlyOwner {
        currentDay = _day;
    }

    /**
     * @dev Função para testes - permite definir o tempo inicial
     */
    function setStartTime(uint256 _startTime) external onlyOwner {
        startTime = _startTime;
    }
}
