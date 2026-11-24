// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27 <0.9.0;

import {Action} from "@efs/solidity/interfaces/Actions.sol";
import {ILedger} from "@efs/solidity/interfaces/ILedger.sol";
import {EfsFiles} from "@efs/solidity/lib/EfsFiles.sol";
import {EfsNative} from "@efs/solidity/lib/EfsNative.sol";

/// @notice A consumer of @efs/solidity, compiled against the release archive: a contract that writes to an EFS
///         ledger as itself. Each message becomes a content-addressed files-bytes/1 record whose author is this
///         contract's own principal on the ledger's Realm, never the account that called it.
contract Guestbook {
    ILedger public immutable ledger;
    /// The deployment's files-bytes/1 TypeId (efs-deployment/1 `typeIds`).
    bytes32 public immutable bytesType;

    event Signed(bytes32 indexed recordId, uint64 publication);

    constructor(ILedger ledger_, bytes32 bytesType_) {
        ledger = ledger_;
        bytesType = bytesType_;
    }

    /// The principal every message is authored by.
    function author() external view returns (bytes32) {
        return EfsNative.myPrincipal(ledger);
    }

    /// Store `message` on the ledger. Bound to the live execution set and acceptance profile, with the next nonce.
    function sign(bytes calldata message) external returns (bytes32 recordId) {
        bytes memory body = EfsFiles.bytesBody(message);
        Action[] memory one = new Action[](1);
        one[0] = EfsNative.publishAction(bytesType, body);
        uint64 publication;
        (publication, recordId) = EfsNative.publish(
            ledger, EfsNative.nextNonce(ledger), EfsNative.currentBind(ledger, one), bytesType, body
        );
        emit Signed(recordId, publication);
    }
}
