// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

/// @title Smoke
/// @notice S0 placeholder. NOT EFS API. It exists only to prove the Foundry build,
///         the npm/archive packaging and the consumer remapping. The first feature
///         PR (F6 in the initialization plan) deletes it. See LIMITATIONS.md.
/// @dev Internal functions only: consumers compile it in; nothing is deployed or linked.
library Smoke {
    function echo(uint256 value) internal pure returns (uint256) {
        return value;
    }
}
