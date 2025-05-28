"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFilterQuery = buildFilterQuery;
const qs_1 = __importDefault(require("qs"));
function buildFilterQuery(search = '') {
    const parsed = qs_1.default.parse(search);
    const { filters, sort: sortRaw } = parsed;
    // Handle the sort parameter type-safely
    let sort = {};
    if (typeof sortRaw === 'string') {
        const [attr, value] = sortRaw.split(':');
        if (attr && value) {
            sort[attr] = value.toLowerCase();
        }
    }
    return {
        filters,
        sort,
    };
}
