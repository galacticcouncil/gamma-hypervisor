// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @title SaucerSwap/Hedera-compatible IUniswapV3Factory interface with mintFee
interface IHederaUniswapV3Factory {
    /// @notice Returns the current owner of the factory
    function owner() external view returns (address);

    /// @notice Returns the current rentPayer of the factory
    function rentPayer() external view returns (address);

    /// @notice Returns current pool create fee in tinycents
    function poolCreateFee() external view returns (uint256);

    /// @notice Returns current mint fee in tinycents
    function mintFee() external view returns (uint256);

    /// @notice Returns the tick spacing for a given fee amount, if enabled, or 0 if not enabled
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);

    /// @notice Returns the pool address for a given pair of tokens and a fee, or address 0 if it does not exist
    function getPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external view returns (address pool);

    /// @notice Creates a pool for the given two tokens and fee
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee
    ) external payable returns (address pool);

    /// @notice Updates the owner of the factory
    function setOwner(address _owner) external;

    /// @notice Enables a fee amount with the given tickSpacing
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;

    /// @notice Sets the pool create fee in tinycents
    function setPoolCreateFee(uint256 _poolCreateFee) external;

    /// @notice Sets the mint fee in tinycents
    function setMintFee(uint256 _mintFee) external;

    /// @notice Updates the rent payer of the factory
    function setRentPayer(address _rentPayer) external;

    /// @notice Sends accumulated rent to rentPayer
    function collectRent() external;
}
