"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.import = exports.export = exports.importAdmin = exports.exportAdmin = void 0;
const export_controller_1 = __importDefault(require("./admin/export-controller"));
exports.exportAdmin = export_controller_1.default;
const import_controller_1 = __importDefault(require("./admin/import-controller"));
exports.importAdmin = import_controller_1.default;
const export_controller_2 = __importDefault(require("./content-api/export-controller"));
exports.export = export_controller_2.default;
const import_controller_2 = __importDefault(require("./content-api/import-controller"));
exports.import = import_controller_2.default;
const controllers = {
    exportAdmin: export_controller_1.default,
    importAdmin: import_controller_1.default,
    export: export_controller_2.default,
    import: import_controller_2.default,
};
exports.default = controllers;
