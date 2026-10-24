import { ethers } from "hardhat";
import type { Signer, TypedDataDomain } from "ethers";

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "projectId", type: "uint256" },
    { name: "geometryHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "baselineYear", type: "uint16" },
    { name: "monitoringYear", type: "uint16" },
    { name: "ndviBaseline", type: "int32" },
    { name: "ndviMonitoring", type: "int32" },
    { name: "controlDelta", type: "int32" },
    { name: "netGain", type: "int32" },
    { name: "validCoverageBps", type: "uint32" },
    { name: "canopyGainHa100", type: "uint32" },
    { name: "creditTonnes", type: "uint64" },
    { name: "passed", type: "bool" },
    { name: "expiry", type: "uint64" },
  ],
};

export const REVERSAL_TYPES = {
  Reversal: [
    { name: "projectId", type: "uint256" },
    { name: "batchId", type: "uint256" },
    { name: "reportHash", type: "bytes32" },
    { name: "lostTonnes", type: "uint64" },
    { name: "expiry", type: "uint64" },
  ],
};

export type Attestation = {
  projectId: bigint;
  geometryHash: string;
  reportHash: string;
  baselineYear: number;
  monitoringYear: number;
  ndviBaseline: number;
  ndviMonitoring: number;
  controlDelta: number;
  netGain: number;
  validCoverageBps: number;
  canopyGainHa100: number;
  creditTonnes: bigint;
  passed: boolean;
  expiry: bigint;
};

export async function domainOf(contract: { getAddress(): Promise<string> }): Promise<TypedDataDomain> {
  const { chainId } = await ethers.provider.getNetwork();
  return { name: "ProofOfForest", version: "1", chainId, verifyingContract: await contract.getAddress() };
}

/** Sign with every signer and return signatures ordered by ascending signer address (as the contract requires). */
export async function signSorted(
  domain: TypedDataDomain,
  types: Record<string, { name: string; type: string }[]>,
  value: Record<string, unknown>,
  signers: Signer[],
): Promise<string[]> {
  const withAddr = await Promise.all(
    signers.map(async (s) => ({ addr: (await s.getAddress()).toLowerCase(), sig: await s.signTypedData(domain, types, value) })),
  );
  withAddr.sort((a, b) => (BigInt(a.addr) < BigInt(b.addr) ? -1 : 1));
  return withAddr.map((x) => x.sig);
}

export const geom = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
export const report = (s: string) => ethers.keccak256(ethers.toUtf8Bytes("report:" + s));
