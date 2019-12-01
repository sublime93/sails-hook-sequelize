# sails-hook-sequelize

### Example Configuration
```js
module.exports.sequelize = {
  customModelGlobal: 'SQ',
  exposeToGlobal: true,
  defaultAttributes: {
    addedBy: {
      type: 'INTEGER',
      allowNull: false
    },
    updatedBy: {
      type: 'INTEGER',
      allowNull: false
    }
  },
  datastores: {
    default: {
      default: true,
      user: 'root',
      password: '',
      database: 'mydb',
      dialect: 'mariadb',
      options: {
        operatorsAliases: false,
        dialect: 'mariadb',
        host   : 'localhost',
        port   : 3307,
        logging: 'debug'      // console.log or specify sails log level to use ('info', 'warn', 'verbose', etc)
      }
    }
  }
};

```
