pragma solidity 0.7.6;

import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

contract FeeRecipientV2 {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    address public owner;
    address public feeManager;
    mapping(address => uint256) public recipientShares;
    address[] public recipients;

    event Send(address token, address recipient, uint256 amount);
    event RecipientAdded(address recipient, uint256 share);
    event RecipientRemoved(address recipient);
    event ShareUpdated(address recipient, uint256 share);
    event OwnershipTransferred(address oldOwner, address newOwner);
    event FeeManagerTransferred(address oldFeeManager, address newFeeManager);
    event RescueERC20(address token, address to, uint256 amount);
    event RecipientSwapped(address oldRecipient, address newRecipient);
    
    constructor(address _owner, address _feeManager) {
        owner = _owner;
        feeManager = _feeManager;
    }

    function addRecipient(address _recipient, uint256 _share) external onlyOwner {
        require(_recipient != address(0), "Cannot add zero address as recipient");
        require(!isRecipient(_recipient), "Recipient already added");
        recipients.push(_recipient);
        recipientShares[_recipient] = _share;
        emit RecipientAdded(_recipient, _share);
    }

    function isRecipient(address _address) public view returns (bool) {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == _address) {
                return true;
            }
        }
        return false;
    }

    function removeRecipient(address _recipient) external onlyOwner returns (bool) {
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == _recipient) {
                recipientShares[_recipient] = 0;
                recipients[i] = recipients[recipients.length - 1];
                recipients.pop();
                emit RecipientRemoved(_recipient);
                return true;
            }
        }
        revert("Recipient not found");
    }

    function setRecipientShare(address _recipient, uint256 _share) external onlyOwner {
        require(isRecipient(_recipient), "Address is not a valid recipient");
        require(_share > 0, "Share must be greater than 0");
        recipientShares[_recipient] = _share;
        emit ShareUpdated(_recipient, _share);
    }

    function swapRecipient(address newRecipient) external {
        require(newRecipient != address(0), "New recipient cannot be zero address");
        require(isRecipient(msg.sender), "Caller is not a recipient");
        require(!isRecipient(newRecipient), "New address is already a recipient");
        
        uint256 currentShare = recipientShares[msg.sender];
        recipientShares[msg.sender] = 0;
        recipientShares[newRecipient] = currentShare;
        
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == msg.sender) {
                recipients[i] = newRecipient;
                break;
            }
        }
        
        emit RecipientSwapped(msg.sender, newRecipient);
    }

    function sendToken(address token1, address token2) external onlyFeeManagerOrRecipient {
        uint256 totalShares = 0;
        uint256 precisionFactor = 10**36;

        // Calculate the total shares
        for (uint256 i = 0; i < recipients.length; i++) {
            totalShares = totalShares.add(recipientShares[recipients[i]]);
        }

        // Get the total balance of the tokens in the contract
        uint256 totalAmount1 = IERC20(token1).balanceOf(address(this));
        uint256 totalAmount2 = IERC20(token2).balanceOf(address(this));

        // Distribute each token according to the shares
        for (uint256 i = 0; i < recipients.length; i++) {
            address recipient = recipients[i];
            uint256 share = recipientShares[recipient];
            uint256 amountToSend1 = totalAmount1.mul(share).mul(precisionFactor).div(totalShares).div(precisionFactor);
            uint256 amountToSend2 = totalAmount2.mul(share).mul(precisionFactor).div(totalShares).div(precisionFactor);
        
            IERC20(token1).safeTransfer(recipient, amountToSend1);
            IERC20(token2).safeTransfer(recipient, amountToSend2);

            emit Send(token1, recipient, amountToSend1);
            emit Send(token2, recipient, amountToSend2);
        }
    }


    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "New owner cannot be the zero address");
        require(newOwner != owner, "New owner must be different");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function transferFeeManager(address newFeeManager) external onlyOwner {
        require(newFeeManager != address(0), "New fee manager cannot be the zero address");
        require(newFeeManager != feeManager, "New fee manager must be different");
        emit FeeManagerTransferred(feeManager, newFeeManager);
        feeManager = newFeeManager;
    }

    function rescueERC20(address tokenAddress, address to, uint256 amount) external onlyOwner {
        IERC20(tokenAddress).safeTransfer(to, amount);
        emit RescueERC20(tokenAddress, to, amount);
    }

    modifier onlyOwner {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyFeeManager {
        require(msg.sender == feeManager, "only fee manager");
        _;
    }

    modifier onlyFeeManagerOrRecipient() {
        require(msg.sender == feeManager || isRecipient(msg.sender), "Caller is not fee manager or recipient");
        _;
    }
}
