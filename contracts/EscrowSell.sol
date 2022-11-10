// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Helpers} from "./libraries/Helpers.sol";
import "./IRODO.sol";

contract EscrowSell is Ownable, ReentrancyGuard {
    using SafeERC20 for IRODO;

    enum SellStatus {
        Pending,
        Executed,
        Claimed,
        Executeable,
        Claimeable
    }

    struct SellInfo {
        uint256 amount;
        uint256 feeAmount;
        uint256 startBlock;
        uint256 endBlock;
        SellStatus status;
    }

    // price of token in eth.
    uint256 public price;

    // rodo token address
    IRODO public rodo;

    // fee that will be received on top of price. 5000 = 5%
    uint256 public feePercentage;

    // fee receiver that will receive 10% share and fee on top of tokens price.
    address public lpAdmin;

    // Admin address that will receive the 40% share and tokens price.
    address public admin;

    uint256 public escrowBlocks;

    uint256 public totalAdminTokens;

    uint256 public totalLpTokens;

    uint256 public totalSellQueueTokens;

    mapping(address => SellInfo[]) public sellInfo;

    modifier onlyAdmin() {
        require(admin == _msgSender(), "Escrow: caller is not admin");
        _;
    }

    modifier onlyLpAdmin() {
        require(lpAdmin == _msgSender(), "Escrow: caller is not lpadmin");
        _;
    }

    constructor(
        IRODO _rodo,
        uint256 _price,
        uint256 _feePercentage,
        uint256 _escrowBlocks,
        address _lpAdmin,
        address _admin
    ) {
        Helpers.requireNonZeroAddress(address(_rodo));
        Helpers.requireNonZeroAddress(address(_admin));
        Helpers.requireNonZeroAddress(address(_lpAdmin));
        price = _price;
        rodo = _rodo;
        feePercentage = _feePercentage;
        escrowBlocks = _escrowBlocks;
        admin = _admin;
        lpAdmin = _lpAdmin;
    }

    function getRequiredEth(uint256 _amount) public view returns (uint256) {
        return (_amount * price) / 1e2;
    }

    function getUserSells(address _account)
        public
        view
        returns (SellInfo[] memory)
    {
        return sellInfo[_account];
    }

    function getAdminRequiredTokens(address _account, uint256 _pid)
        public
        view
        returns (uint256)
    {
        SellInfo memory userSellInfo = sellInfo[_account][_pid];

        return (userSellInfo.amount * 20) / 100;
    }

    function getLpRequiredTokens(address _account, uint256 _pid)
        public
        view
        returns (uint256)
    {
        SellInfo memory userSellInfo = sellInfo[_account][_pid];

        return (userSellInfo.amount * 80) / 100;
    }

    function status(address _account, uint256 _pid)
        public
        view
        returns (SellStatus)
    {
        SellInfo memory userSellInfo = sellInfo[_account][_pid];

        if (userSellInfo.status == SellStatus.Executed) {
            return SellStatus.Executed;
        }

        if (userSellInfo.status == SellStatus.Claimed) {
            return SellStatus.Claimed;
        }

        if (
            block.number <= userSellInfo.endBlock &&
            totalAdminTokens >= getAdminRequiredTokens(_account, _pid) &&
            totalLpTokens >= getLpRequiredTokens(_account, _pid)
        ) {
            return SellStatus.Executeable;
        } else if (block.number > userSellInfo.endBlock) {
            return SellStatus.Claimeable;
        } else return SellStatus.Pending;
    }

    function sell(uint256 _amount) public {
        address account = msg.sender;
        require(_amount > 0, "Escrow: Amount cannot be 0");
        uint256 fee = (_amount * feePercentage) / 1e5;
        uint256 amount = _amount + fee;
        sellInfo[account].push(
            SellInfo({
                amount: _amount,
                feeAmount: fee,
                startBlock: block.number,
                endBlock: block.number + escrowBlocks,
                status: SellStatus.Pending
            })
        );
        totalSellQueueTokens += _amount;
        rodo.transferFrom(account, address(this), amount);
    }

    function execute(uint256 _pid) public nonReentrant {
        address account = msg.sender;
        SellInfo storage userSellInfo = sellInfo[account][_pid];
        uint256 adminRequiredTokens = getAdminRequiredTokens(account, _pid);
        uint256 lpRequiredTokens = getLpRequiredTokens(account, _pid);
        uint256 requiredEth = getRequiredEth(userSellInfo.amount);
        require(
            totalAdminTokens >= adminRequiredTokens,
            "Escrow: low admin tokens"
        );
        require(totalLpTokens >= lpRequiredTokens, "Escrow: low lp tokens");
        require(
            requiredEth <= address(this).balance,
            "Escrow: low eth balance"
        );
        require(
            userSellInfo.startBlock < block.number &&
                userSellInfo.endBlock >= block.number,
            "Escrow: invalid block"
        );
        require(
            userSellInfo.status == SellStatus.Pending,
            "Escrow: invalid status"
        );
        totalAdminTokens -= adminRequiredTokens;
        totalLpTokens -= lpRequiredTokens;
        totalSellQueueTokens -= userSellInfo.amount;
        userSellInfo.status = SellStatus.Executed;
        payable(account).transfer(requiredEth);
        rodo.transfer(admin, userSellInfo.feeAmount);
        rodo.burn(userSellInfo.amount);
    }

    function claim(uint256 _pid) public nonReentrant {
        address account = msg.sender;
        SellInfo storage userSellInfo = sellInfo[account][_pid];
        require(userSellInfo.endBlock < block.number, "Escrow: invalid block");
        require(
            userSellInfo.status == SellStatus.Pending,
            "Escrow: invalid status"
        );
        userSellInfo.status = SellStatus.Claimed;
        totalSellQueueTokens -= userSellInfo.amount;
        rodo.transfer(account, userSellInfo.amount + userSellInfo.feeAmount);
    }

    function getTotalRequiredAdminTokens() public view returns (uint256) {
        return (totalSellQueueTokens * 20) / 100;
    }

    function getTotalRequiredLpAdminTokens()
        public
        view
        returns (uint256, uint256)
    {
        uint256 amount = (totalSellQueueTokens * 80) / 100;
        return (amount, getRequiredEth(totalSellQueueTokens));
    }

    function addAdminTokens(uint256 _amount) public onlyAdmin {
        address account = msg.sender;
        totalAdminTokens += _amount;
        rodo.transferFrom(account, address(this), _amount);
    }

    function addLpAdminTokens(uint256 _amount) public payable onlyLpAdmin {
        address account = msg.sender;
        uint256 requiredEth = getRequiredEth(_amount);
        require(msg.value >= requiredEth, "Escrow: low eth provided");
        totalLpTokens += _amount;
        rodo.transferFrom(account, address(this), _amount);
    }

    function updatePrice(uint256 _price) public onlyOwner {
        price = _price;
    }

    function updateAdmin(address _admin) public onlyOwner {
        Helpers.requireNonZeroAddress(_admin);
        admin = _admin;
    }

    function updateLpAdmin(address _lpAdmin) public onlyOwner {
        Helpers.requireNonZeroAddress(_lpAdmin);
        lpAdmin = _lpAdmin;
    }

    function updateFeePercentage(uint256 _feePercentage) public onlyOwner {
        require(_feePercentage <= 1e5, "Escrow: fee percentage exceeding.");
        feePercentage = _feePercentage;
    }

    function updateRodo(IRODO _rodo) public onlyOwner {
        Helpers.requireNonZeroAddress(address(_rodo));
        rodo = _rodo;
    }

    function updateEscrowBlocks(uint256 _escrowBlocks) public onlyOwner {
        escrowBlocks = _escrowBlocks;
    }

    function withdrawToken(IRODO _token, uint256 _amount) public onlyOwner {
        _token.transfer(owner(), _amount);
    }

    function withdrawEth(uint256 _amount) public onlyOwner {
        payable(owner()).transfer(_amount);
    }
}
