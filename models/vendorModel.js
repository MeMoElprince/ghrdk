const db = require("../config/database");
const Sequelize = require("sequelize");

const Vendor = db.define("vendors", {
  user_id: {
    type: Sequelize.INTEGER,
    references: {
      model: 'users',
      key: 'id'
    },
    unique: true
  },
  reviewed: {
    type: Sequelize.BOOLEAN,
    defaultValue: false,
  },
  national_id: {
    type: Sequelize.STRING,
    allowNull: false,
  }
});

module.exports = Vendor;
