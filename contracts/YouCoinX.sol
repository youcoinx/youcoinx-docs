// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract YouCoinX is ERC20Upgradeable, OwnableUpgradeable, UUPSUpgradeable {
    // Constantes
    uint256 private constant INITIAL_SUPPLY = 8045311447 * 10**18;
    uint256 private constant GROWTH_DENOMINATOR = 1000;
    uint256 private constant REWARDS_GROWTH_SHARE = 80;
    uint256 private constant MAX_GROWTH_RATE = 50; // 5%
    
    // Constantes de Taxa de Transação
    uint256 private constant MIN_TX_FEE = 10; // 1%
    uint256 private constant MAX_TX_FEE = 30; // 3%
    uint256 private constant TX_FEE_DENOMINATOR = 1000;

    // Carteiras
    address public presaleWallet;
    address public liquidityWallet;
    address public rewardsPoolWallet;
    address public operationalWallet;

    // Estado
    uint256 public lastGrowthTime;
    uint256 public annualGrowthRate;
    uint256 public transactionFeeRate;
    mapping(address => bool) public registeredModules;

    // Erros personalizados
    error GrowthTooEarly();
    error GrowthRateExceedsMax();
    error InvalidWallet();
    error DuplicateWallet();
    error ModuleAlreadyRegistered();
    error ModuleNotRegistered();
    error TransactionFeeOutOfRange();

    // Eventos
    event AnnualGrowthExecuted(uint256 totalGrowth, uint256 rewardsPoolGrowth, uint256 operationalGrowth);
    event GrowthRateUpdated(uint256 oldRate, uint256 newRate);
    event TransactionFeeUpdated(uint256 oldFee, uint256 newFee);
    event ModuleRegistered(address indexed module);
    event ModuleUnregistered(address indexed module);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _presaleWallet,
        address _liquidityWallet,
        address _rewardsPoolWallet,
        address _operationalWallet
    ) public initializer {
        __ERC20_init("YouCoinX", "YCNX");
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        if (_presaleWallet == address(0)) revert InvalidWallet();
        if (_liquidityWallet == address(0)) revert InvalidWallet();
        if (_rewardsPoolWallet == address(0)) revert InvalidWallet();
        if (_operationalWallet == address(0)) revert InvalidWallet();

        if (_presaleWallet == _liquidityWallet ||
            _presaleWallet == _rewardsPoolWallet ||
            _presaleWallet == _operationalWallet ||
            _liquidityWallet == _rewardsPoolWallet ||
            _liquidityWallet == _operationalWallet ||
            _rewardsPoolWallet == _operationalWallet) {
            revert DuplicateWallet();
        }

        presaleWallet = _presaleWallet;
        liquidityWallet = _liquidityWallet;
        rewardsPoolWallet = _rewardsPoolWallet;
        operationalWallet = _operationalWallet;
        annualGrowthRate = 11; // 1.1%
        transactionFeeRate = 11; // 1.1%
        lastGrowthTime = block.timestamp;

        // Distribuição inicial de tokens
        _mint(presaleWallet, (INITIAL_SUPPLY * 51) / 100); // 51%
        _mint(liquidityWallet, (INITIAL_SUPPLY * 20) / 100); // 20%
        _mint(rewardsPoolWallet, (INITIAL_SUPPLY * 20) / 100); // 20%
        _mint(operationalWallet, (INITIAL_SUPPLY * 9) / 100); // 9%
    }

    function getAnnualGrowthRate() public view returns (uint256) {
        return annualGrowthRate;
    }

    function setAnnualGrowthRate(uint256 _newRate) public onlyOwner {
        if (_newRate > MAX_GROWTH_RATE) revert GrowthRateExceedsMax();
        uint256 oldRate = annualGrowthRate;
        annualGrowthRate = _newRate;
        emit GrowthRateUpdated(oldRate, _newRate);
    }

    function getTransactionFee() public view returns (uint256) {
        return transactionFeeRate;
    }

    function setTransactionFee(uint256 _newFee) external onlyOwner {
        if (_newFee < MIN_TX_FEE || _newFee > MAX_TX_FEE) revert TransactionFeeOutOfRange();
        uint256 oldFee = transactionFeeRate;
        transactionFeeRate = _newFee;
        emit TransactionFeeUpdated(oldFee, _newFee);
    }

    function executeAnnualGrowth() public onlyOwner {
        if (block.timestamp < lastGrowthTime + 365 days) revert GrowthTooEarly();

        uint256 currentSupply = totalSupply();
        uint256 totalGrowth = (currentSupply * annualGrowthRate) / GROWTH_DENOMINATOR;
        uint256 rewardsPoolGrowth = (totalGrowth * REWARDS_GROWTH_SHARE) / 100;
        uint256 operationalGrowth = totalGrowth - rewardsPoolGrowth;

        _mint(rewardsPoolWallet, rewardsPoolGrowth);
        _mint(operationalWallet, operationalGrowth);

        lastGrowthTime = block.timestamp;
        emit AnnualGrowthExecuted(totalGrowth, rewardsPoolGrowth, operationalGrowth);
    }

    function registerModule(address module) external onlyOwner {
        if (registeredModules[module]) revert ModuleAlreadyRegistered();
        registeredModules[module] = true;
        emit ModuleRegistered(module);
    }

    function unregisterModule(address module) external onlyOwner {
        if (!registeredModules[module]) revert ModuleNotRegistered();
        registeredModules[module] = false;
        emit ModuleUnregistered(module);
    }

    function isModuleRegistered(address module) external view returns (bool) {
        return registeredModules[module];
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override {
        super._update(from, to, amount);

        // Aplicar taxa de transação apenas para transferências normais (não para mint/burn)
        if (from != address(0) && to != address(0)) {
            uint256 fee = (amount * transactionFeeRate) / TX_FEE_DENOMINATOR;
            uint256 rewardsPoolFee = (fee * REWARDS_GROWTH_SHARE) / 100;
            uint256 operationalFee = fee - rewardsPoolFee;

            _mint(rewardsPoolWallet, rewardsPoolFee);
            _mint(operationalWallet, operationalFee);
        }
    }
}
