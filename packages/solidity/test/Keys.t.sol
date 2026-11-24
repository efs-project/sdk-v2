// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import {Test} from "forge-std/Test.sol";
import {Keys} from "@efs/solidity/lib/Keys.sol";
import {KeyVectors as V} from "./generated/KeyVectors.sol";

/// @notice The packaged Keys library against the contracts' golden vectors (test/vectors/ids.json), the same
///         vectors the TypeScript SDK checks its own derivations against: one answer in both languages.
contract KeysTest is Test {
    function shapeOf(bytes calldata descriptor) external pure returns (bytes32) {
        return Keys.shape(descriptor);
    }

    function test_principals() public pure {
        assertEq(Keys.principal(V.IN_eoa), V.OUT_eoaPrincipal);
        assertEq(
            Keys.contractPrincipal(V.IN_realmOrigin, V.IN_contractAddress), V.OUT_contractPrincipal
        );
    }

    function test_typesAndRecords() public pure {
        bytes32[] memory refs = new bytes32[](2);
        refs[0] = V.IN_refType0;
        refs[1] = V.IN_refType1;
        assertEq(Keys.typeId(V.IN_shape, refs, V.IN_ruleId), V.OUT_typeId);
        assertEq(Keys.typeId(V.IN_shape, new bytes32[](0), V.IN_ruleId), V.OUT_typeIdNoRefs);
        assertEq(Keys.record(V.OUT_typeId, V.IN_body), V.OUT_recordId);
        assertEq(Keys.recordFromHash(V.OUT_typeId, V.IN_bodyHash), V.OUT_recordFromHash);
    }

    function test_subjectsPositionsBindingsScopes() public pure {
        assertEq(Keys.subject(V.OUT_eoaPrincipal, V.IN_salt), V.OUT_subjectId);
        assertEq(Keys.position(V.IN_purpose, V.OUT_subjectId, V.IN_role), V.OUT_positionKey);
        assertEq(Keys.binding(V.OUT_eoaPrincipal, V.OUT_positionKey), V.OUT_bindingKey);
        assertEq(Keys.scope(V.OUT_eoaPrincipal, V.IN_purpose, V.OUT_subjectId), V.OUT_scopeKey);
        assertEq(Keys.roleScope(V.OUT_eoaPrincipal, V.IN_purpose, V.IN_role), V.OUT_roleScopeKey);
    }

    function test_realmPublicationRoleKeyShape() public view {
        bytes32 origin = Keys.realmOrigin(11155111, V.IN_contractAddress, V.IN_salt);
        assertEq(origin, V.OUT_realmOrigin);
        assertEq(Keys.realmId(origin, 1), V.OUT_realmId);
        assertEq(
            Keys.contractPrincipal(origin, V.IN_contractAddress), V.OUT_contractPrincipalOfOrigin
        );
        assertEq(Keys.publicationId(V.OUT_eoaPrincipal, V.IN_bodyHash), V.OUT_publicationId);
        assertEq(Keys.roleKey(V.IN_purpose, V.IN_role), V.OUT_roleKey);
        assertEq(this.shapeOf(V.IN_body), V.OUT_shape);
    }

    function test_postingLists() public pure {
        assertEq(Keys.byTypeList(V.OUT_typeId), V.OUT_byTypeList);
        assertEq(Keys.byAuthorList(V.OUT_eoaPrincipal), V.OUT_byAuthorList);
        assertEq(Keys.backlinkList(V.OUT_recordId), V.OUT_backlinkList);
        assertEq(Keys.historyList(V.OUT_bindingKey), V.OUT_historyList);
        assertEq(Keys.scopeList(V.OUT_scopeKey), V.OUT_scopeList);
        assertEq(
            Keys.referenceList(V.OUT_typeId, uint8(V.IN_ordinal), V.OUT_recordId),
            V.OUT_referenceList
        );
        assertEq(Keys.byRecordList(V.OUT_recordId), V.OUT_byRecordList);
        assertEq(Keys.uniqueByTypeList(V.OUT_typeId), V.OUT_uniqueByTypeList);
        assertEq(
            Keys.scalarList(V.OUT_typeId, uint8(V.IN_spec), uint8(V.IN_scalarKind), V.IN_value),
            V.OUT_scalarList
        );
        assertEq(Keys.digestList(V.IN_algorithm, V.IN_value), V.OUT_digestList);
    }
}
