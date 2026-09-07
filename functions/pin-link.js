"use strict";
// Stable callable name; legacy four-digit credentials deliberately not accepted.
const { linkVehicleByCode } = require("./fleet-security");
module.exports = { linkVehicleByPin: linkVehicleByCode };
