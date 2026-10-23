// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockSmartAccount
 * @notice Lightweight ERC-4337 Smart Account simulator for testing gasless user operations.
 * @dev Represents an embedded smart contract wallet provisioned for a warehouse driver or clinic nurse.
 */
contract MockSmartAccount {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    /**
     * @notice Executes a transaction on behalf of this smart wallet.
     * @dev Called by the ERC-4337 EntryPoint or a sponsoring relayer.
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory) {
        require(msg.sender == owner, "Only wallet owner");
        (bool success, bytes memory returnData) = target.call{value: value}(data);
        require(success, "Wallet execution reverted");
        return returnData;
    }

    receive() external payable {}
}
