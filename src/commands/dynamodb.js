const AWS = require('aws-sdk');

class RhobotDynamoDB {
    dynamodb;
    table;

    /**
     * Thin wrapper around the DynamoDB client that knows about the Rhobot table format.
     * 
     * The DynamoDB table structure has a super generic format:
     *  - primary key: a combination of channel and type-identifier
     *  - sort key: a uuid
     * 
     * There are several motivations for this:
     * access pattern is not expected to cross Discord channels;
     * The access pattern is mainly expected to be on individual items. Item type + uuid allows precise queries for those items.
     * Access pattern for multiple items is expected to be for items in the same type (e.g. listing all events).
     * Access patterns along user lines are not expected, so keying on user isn't required for every item.
     * 
     * 
     * @param {string} table - The DynamoDB table to interact with.
     * @param {string} region - The AWS region the table is in.
     */
    constructor(table, region) {
        this.dynamodb = new AWS.DynamoDB({ region });
        this.table = table;
    }

    /**
     * Get all records of a type.
     * 
     * @param {string} channel - the Discord channel ID
     * @param {string} type - the database record type
     */
    readType(channel, type) {
        const primaryKey = getPartitionKey(channel, type);
        const params = {
            TableName: this.table,
            ExpressionAttributeValues: {
                ":type": {
                    S: `${primaryKey}`
                }
            },
            KeyConditionExpression: `type = :type`,
        };

        return this.dynamodb.query(params, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        }).promise();
    }

    /**
     * Get a single record.
     * 
     * @param {string} channel - the discord channel ID
     * @param {string} type - the database record type
     * @param {string} id - the record id
     */
    readItem(channel, type, id) {
        const params = {
            TableName: this.table,
            Key: {
                ...RhobotDynamoDB.getPartitionKeyAttribute(channel, type),
                uuid: { S: id },
            },
        };

        return this.dynamodb.getItem(params).promise();
    }

    /**
     * Create/update an existing record.
     * 
     * @param {string} identifier - the database record ID
     * @param {AWS.DynamoDB.PutItemInputAttributeMap} attributes - non-key DynamoDB item attributes
     */
    put(channel, type, attributes) {
        const ddbItem = {
            ...RhobotDynamoDB.getPartitionKeyAttribute(channel, type),
            ...attributes
        };

        return this.dynamodb.putItem({ TableName: this.table, Item: ddbItem }).promise();
    }

    static getPartitionKeyAttribute(channel, type) {
        return {
            "type": {
                "S": `${channel}${type}`
            },
        }
    }
}

module.exports = { RhobotDynamoDB };