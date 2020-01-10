module.exports = sails => {
  // const Sequelize = require('sequelize-hierarchy')(); // If using hierarchy package
  const Sequelize = require('sequelize');

  // keep a ref to the original sails model loader function
  const originalLoadModels = sails.modules.loadModels;
  let conf;

  return {
    defaults: {
      __configKey__: {
        _hookTimeout: 30000,
        clsNamespace: 'nsequelize',
        exposeToGlobal: true,
        customGlobal: undefined
      }
    },
    configure () {
      this.configKey = 'sequelize';
      conf = sails.config[this.configKey];
      const cls = conf.clsNamespace;

      // If custom log function is specified, use it for SQL logging or use sails logger of defined level
      if (typeof cls === 'string' && cls !== '') {
        Sequelize.useCLS(require('continuation-local-storage').createNamespace(cls));
      }

      if (conf.exposeToGlobal) {
        sails.log.verbose('Exposing Sequelize globally');
        global.Sequelize = Sequelize;
        global.Op = Sequelize.Op;
      }

      // Override sails internal loadModels function
      // needs to be done in configure()
      sails.modules.loadModels = function load (cb) {

        // call the original sails loadModels function so we have access to it's returned models
        originalLoadModels((err, modelDefs) => {
          if (err) throw err;
          // modelDefs = all the model files from models directory - sails does this
          // now modify / return own models for sails to boot
          const models = {};

          sails.log.verbose('Detecting Waterline models');
          if (modelDefs) {
            Object.entries(modelDefs).forEach((entry) => {
              const [key, model] = entry;

              if (typeof (model.options) === 'undefined' || typeof (model.options.tableName) === 'undefined') {
                sails.log.silly('Loading Waterline model \'' + model.globalId + '\'');
                models[key] = model;
              }
            });
          }

          // return the models that the sails orm hook will bootstrap
          cb(err, models);
        });
      };
    },
    initialize (next) {

      if (sails.config.hooks.orm === false) {
        this.initAdapters();
        this.initModels();
        this.reload(next);
      } else {
        sails.on('hook:orm:loaded', () => {
          this.initAdapters();
          this.initModels();
          this.reload(next);
        });
      }
    },

    reload (next) {
      let connections;
      const self = this;

      connections = this.initConnections();

      if (conf.exposeToGlobal) {
        sails.log.verbose('Exposing Sequelize connections globally');
        global.SequelizeConnections = connections;
      }

      return originalLoadModels((err, models) => {
        if (err) {
          return next(err);
        }

        self.defineModels(models, connections);
        self.migrateSchema(next, connections, models);
      });
    },

    initAdapters () {
      if (typeof (sails.adapters) === 'undefined') {
        sails.adapters = {};
      }
    },

    initConnections () {
      const connections = {};
      let connection, connectionName;

      // Try to read settings from old Sails then from the new.
      // 0.12: sails.config.connections & sails.config.models.connection
      // 1.00: sails.config.datastores & sails.config.models.datastore
      let datastores = conf.datastores || sails.config.connections || sails.config.datastores;
      const datastoreName = sails.config.models.connection || sails.config.models.datastore || 'default';

      sails.log.verbose('Using default connection named ' + datastoreName);
      if (!datastores.hasOwnProperty(datastoreName)) {
        throw new Error('Default connection \'' + datastoreName + '\' not found in config/connections');
      }

      for (connectionName in datastores) {
        connection = datastores[connectionName];

        // Skip waterline connections
        if (connection.adapter) continue;
        if (!connection.options) connection.options = {};

        // If custom log function is specified, use it for SQL logging or use sails logger of defined level
        if (typeof connection.options.logging === 'string' && connection.options.logging !== '') {
          connection.options.benchmark = true;
          let logType = connection.options.logging;
          connection.options.logging = function (log, benchmark) {
            log = log.replace('Executing', 'SQ -');
            sails.log[logType](`${benchmark}ms - ${log}`);
          }
        }

        if (connection.options.operatorsAliases === undefined || connection.options.operatorsAliases) sails.log.warn('Using operator aliases is not recommended.  They can cause security issues if used improperly.');
        if (connection.options.operatorsAliases) {
          connection.options.operatorsAliases = {
            $eq: Op.eq,
            $ne: Op.ne,
            $gte: Op.gte,
            $gt: Op.gt,
            $lte: Op.lte,
            $lt: Op.lt,
            $not: Op.not,
            $in: Op.in,
            $notIn: Op.notIn,
            $is: Op.is,
            $like: Op.like,
            $notLike: Op.notLike,
            $iLike: Op.iLike,
            $notILike: Op.notILike,
            $regexp: Op.regexp,
            $notRegexp: Op.notRegexp,
            $iRegexp: Op.iRegexp,
            $notIRegexp: Op.notIRegexp,
            $between: Op.between,
            $notBetween: Op.notBetween,
            $overlap: Op.overlap,
            $contains: Op.contains,
            $contained: Op.contained,
            $adjacent: Op.adjacent,
            $strictLeft: Op.strictLeft,
            $strictRight: Op.strictRight,
            $noExtendRight: Op.noExtendRight,
            $noExtendLeft: Op.noExtendLeft,
            $and: Op.and,
            $or: Op.or,
            $any: Op.any,
            $all: Op.all,
            $values: Op.values,
            $col: Op.col
          }
        }

        if (connection.url) {
          connections[connectionName] = new Sequelize(connection.url, connection.options);
        } else {
          connections[connectionName] = new Sequelize(connection.database,
            connection.user,
            connection.password,
            connection.options);
        }
        if (connection.default) connections.default = connections[connectionName];
      }

      return connections;
    },

    initModels () {
      if (typeof (sails.models) === 'undefined') sails.models = {};
    },

    defineModels (models, connections) {
      let modelDef, modelName, modelClass, cm, im, connectionName;
      const sequelizeMajVersion = parseInt(Sequelize.version.split('.')[0], 10);

      // Try to read settings from old Sails then from the new.
      // 0.12: sails.config.models.connection
      // 1.00: sails.config.models.datastore
      const defaultConnection = sails.config.models.connection || sails.config.models.datastore || 'default';

      for (modelName in models) {
        modelDef = models[modelName];
        if (modelDef.sequelizeDefinition) {
          let t = modelDef.sequelizeDefinition;
          Object.assign(modelDef, t);
        }

        // Skip models without options provided (possible Waterline models)
        if (!modelDef.options) continue;

        // Apply default attributes if they exist
        if (conf.defaultAttributes) {
          for (let defAttrName in conf.defaultAttributes) {
            // Check if attribute is already defined. Ignore if found
            if (modelDef.attributes[defAttrName] === false) {
              delete modelDef.attributes[defAttrName];
              continue;
            }

            // Ignore if attribute is already defined.
            if (modelDef.attributes[defAttrName]) continue;

            let defAttribute = conf.defaultAttributes[defAttrName];
            sails.log.silly(`Adding default attribute: ${defAttrName} to model: ${modelDef.globalId}. If you do not want to add this set ${defAttrName} = false on your sequelize attribute definition.`);
            modelDef.attributes[defAttrName] = {
              type: Sequelize[defAttribute.type],
              allowNull: defAttribute.allowNull
            };
          }
        }

        sails.log.silly(`Loading Sequelize model ${modelDef.globalId}`);
        connectionName = modelDef.connection || modelDef.datastore || defaultConnection;
        modelClass = connections[connectionName].define(modelDef.globalId, modelDef.attributes, modelDef.options);

        // Enable hierarchy
        if (!!modelDef.hierarchy) {
          let options = (typeof modelDef.hierarchy === 'object') ? modelDef.hierarchy : { };
          options.throughTable = options.throughTable || `${modelClass.tableName}ancestors`;
          modelClass.isHierarchy(options);
        }

        if (sequelizeMajVersion >= 4) {
          for (cm in modelDef.options.classMethods) {
            modelClass[cm] = modelDef.options.classMethods[cm];
          }

          for (im in modelDef.options.instanceMethods) {
            modelClass.prototype[im] = modelDef.options.instanceMethods[im];
          }
        }

        if (sails.config.globals.models) {
          if (conf.customModelGlobal) {
            sails.log.silly(`Exposing model ${modelDef.globalId} globally via ${conf.customModelGlobal}`);
            if (!global[conf.customModelGlobal]) global[conf.customModelGlobal] = { };
            global[conf.customModelGlobal][modelDef.globalId] = modelClass;
          } else {
            sails.log.silly(`Exposing model ${modelDef.globalId} globally`);
            global[modelDef.globalId] = modelClass;
          }
        }
        sails.models[modelDef.globalId.toLowerCase()] = modelClass;
      }

      for (modelName in models) {
        modelDef = models[modelName];

        // Skip models without options provided (possible Waterline models)
        if (!modelDef.options) {
          continue;
        }

        this.setAssociation(modelDef);
        this.setDefaultScope(modelDef, sails.models[modelDef.globalId.toLowerCase()]);
      }
      global[conf.customModelGlobal].isLoaded = true;
    },

    setAssociation (modelDef) {
      if (modelDef.associations !== null) {
        sails.log.silly('Loading associations for \'' + modelDef.globalId + '\'');
        if (typeof modelDef.associations === 'function') {
          modelDef.associations(modelDef);
        }
      }
    },

    setDefaultScope (modelDef, model) {
      if (modelDef.defaultScope !== null) {
        // sails.log.debug('Loading default scope for \'' + modelDef.globalId + '\'');
        if (typeof modelDef.defaultScope === 'function') {
          const defaultScope = modelDef.defaultScope() || {};
          model.addScope('defaultScope', defaultScope, { override: true });
        }
      }
    },

    migrateSchema (next, connections, models) {
      let connectionDescription, connectionName, migrate, forceSyncFlag, alterFlag;
      const syncTasks = [];

      // Try to read settings from old Sails then from the new.
      // 0.12: sails.config.connections
      // 1.00: sails.config.datastores
      const datastores = conf.datastores || sails.config.connections || sails.config.datastores;

      migrate = sails.config.models.migrate;
      sails.log.verbose('Models migration strategy: ' + migrate);

      if (migrate === 'safe') {
        return next();
      } else {
        switch (migrate) {
          case 'drop':
            forceSyncFlag = true;
            alterFlag = false;
            break;
          case 'alter':
            forceSyncFlag = false;
            alterFlag = true;
            break;
          default:
            forceSyncFlag = false;
            alterFlag = false;
        }

        for (connectionName in datastores) {
          connectionDescription = datastores[connectionName];

          // Skip waterline connections
          if (connectionDescription.adapter) {
            continue;
          }

          sails.log.verbose('Migrating schema in \'' + connectionName + '\' connection');

          if (connectionDescription.dialect === 'postgres') {

            syncTasks.push(connections[connectionName].showAllSchemas().then(schemas => {
              let modelName, modelDef, tableSchema;

              for (modelName in models) {
                modelDef = models[modelName];
                if (!modelDef.options) throw new Error(`Options not defined on model: ${modleDef.globalId}`);
                tableSchema = modelDef.options.schema || '';

                if (tableSchema !== '' && schemas.indexOf(tableSchema) < 0) { // there is no schema in db for model
                  connections[connectionName].createSchema(tableSchema);
                  schemas.push(tableSchema);
                }
              }

              return connections[connectionName].sync({ force: forceSyncFlag, alter: alterFlag });
            }));

          } else {
            syncTasks.push(connections[connectionName].sync({ force: forceSyncFlag, alter: alterFlag }));
          }
        }

        Promise.all(syncTasks).then(() => next()).catch(e => next(e));

      }
    }
  };
};
