// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import {Test} from "forge-std/Test.sol";
import {Smoke} from "@efs/solidity/smoke/Smoke.sol";

/// @notice S0 placeholder test: proves forge-std, remappings and the test runner work.
contract SmokeTest is Test {
    function testFuzz_echo(uint256 value) public pure {
        assertEq(Smoke.echo(value), value);
    }
}
