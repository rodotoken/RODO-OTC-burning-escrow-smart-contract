// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRODO is IERC20 {
    function burnFrom(address from, uint256 value) external;

    function burn(uint256 value) external;
}
