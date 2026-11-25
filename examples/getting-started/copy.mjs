// SPDX-License-Identifier: MIT
// What each SDK outcome means to a person. Branch on state first, then reason.code, then reason.retry; never parse
// reason.detail. Say "not sent" only where the SDK proved nothing was broadcast.
import { EfsFault } from "@efs/sdk";

/** Codes the SDK returns only when nothing was broadcast (a refusal before signing, or a check that failed). */
const NOTHING_SENT = new Set([
  "USER_REJECTED",
  "WALLET_UNAUTHORIZED",
  "WALLET_UNSUPPORTED",
  "WALLET_INVALID_PARAMS",
  "WALLET_MISMATCH",
  "OVER_TX_GAS_CAP",
  "STALE",
  "BUSY",
  "JOURNAL_UNAVAILABLE",
]);

/** efs.at(): may this page show chain data as EFS data? */
export function describePin(pin) {
  if (pin.status === "VERIFIED") return "Connected";
  if (pin.status === "MISMATCH") return "This network is not the EFS deployment this app expects";
  return "Can't check the network right now — try again"; // UNKNOWN: never "not EFS"
}

/** openFile(): what is at this link? */
export function describeOpen(opened) {
  switch (opened.status) {
    case "PRESENT":
      return "Opened";
    case "ABSENT_PROVEN":
      return "This file doesn't exist in this view";
    case "MASKED":
      return "Hidden in this view";
    case "CONFLICT":
      return "Two authors disagree about this file in this view";
    case "INVALID":
      return "This file's data is malformed";
    default:
      return "Can't load this file right now — try again"; // UNKNOWN is never "doesn't exist"
  }
}

/** A save (runSequence / resume / reconcileSequence / pendingSequences): state, then code, then retry. */
export function describeSave(p) {
  const code = p.reason?.code;
  if (p.state === "COMPLETE") return p.final ? "Saved" : "Saved · confirming";
  if (p.state === "ABANDONED") return "Stopped (anything already saved stays saved)";
  if (p.state === "IN_FLIGHT") {
    if (code === "REORGED") return "Undone by the network — checking";
    if (code === "WALLET_DISCONNECTED" || code === "WALLET_CHAIN_DISCONNECTED")
      return "Your wallet lost its connection — checking whether the save went out";
    return "Sent — checking"; // settles by itself (reconcileSequence), never "not sent"
  }
  // NOT_STARTED or PARTIAL
  const where =
    p.state === "PARTIAL" ? `Partially saved (${p.committed} of ${p.total})` : "Not saved";
  if (code === "STALE" && p.reason.revert?.error === "E_CAS")
    return `${where}: this file changed since you opened it — Review changes`;
  if (code === "EXPIRED") return `${where}: it didn't go through in time — Send again`;
  if (code === "REORGED_DROPPED") return `${where}: it was undone by the network — Send again`;
  if (code === "WALLET_MISMATCH") {
    const e = p.reason.wallet.expected;
    return `${where}: switch your wallet back to ${e.account} on chain ${e.chainId}, then Continue`;
  }
  const nothing = p.state === "NOT_STARTED" && NOTHING_SENT.has(code) ? " Nothing was sent." : "";
  if (code === "USER_REJECTED")
    return `${where}: you declined in your wallet.${nothing} — Try again`;
  const retry = p.reason?.retry;
  if (retry === "transient" || retry === "after-reconcile") return `${where}.${nothing} — Continue`;
  return `${where}.${nothing} (${code ?? "no reason"})`;
}

/** A throw from runSequence / resume: never "nothing was saved" unless the SDK says so. */
export function describeThrow(e) {
  if (!(e instanceof EfsFault)) return "Something went wrong";
  if (e.sequenceMayHaveSent === false) return "Not saved. Nothing was sent.";
  if (e.sequenceId) return "We couldn't confirm this save yet — checking"; // reconcileSequence(e.sequenceId) later
  return `Something went wrong (${e.code})`;
}
