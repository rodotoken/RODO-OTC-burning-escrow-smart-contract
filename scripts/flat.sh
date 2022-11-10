#!/usr/bin/env bash

for contract in "Escrow" "EscrowSell"
do
  npx hardhat flatten contracts/$contract.sol > flatten/$contract.flatten.sol
done