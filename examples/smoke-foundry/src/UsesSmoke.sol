// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import {Smoke} from "@efs/solidity/smoke/Smoke.sol";

/// @notice S0 placeholder example: compiles the internal library into a consumer contract.
contract UsesSmoke {
    function echo(uint256 value) external pure returns (uint256) {
        return Smoke.echo(value);
    }
}
