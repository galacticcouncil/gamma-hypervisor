// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.5.0;

/// @title Hedera Exchange Rate Precompile Interface
/// @notice Interface for interacting with the Hedera Exchange Rate precompile at address 0x168
interface IExchangeRate {
    /// @notice Converts tinycents to tinybars using the current Hedera exchange rate
    /// @dev Tinycents are 1e-8 US cents (1e-10 USD). Tinybars are 1e-8 HBAR.
    /// The rate is derived from the HBAR-USD rate stored in system file 0.0.112.
    /// @param tinycents The amount in tinycents to convert
    /// @return tinybars The equivalent amount in tinybars
    function tinycentsToTinybars(uint256 tinycents) external returns (uint256 tinybars);

    /// @notice Converts tinybars to tinycents using the current Hedera exchange rate
    /// @param tinybars The amount in tinybars to convert
    /// @return tinycents The equivalent amount in tinycents
    function tinybarsToTinycents(uint256 tinybars) external returns (uint256 tinycents);
}
