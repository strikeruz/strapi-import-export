"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = [
    {
        method: 'GET',
        path: '/',
        // name of the controller file & the method.
        handler: 'controller.index',
        config: {
            policies: [],
        },
    },
];
