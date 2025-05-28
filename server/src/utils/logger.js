"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = exports.LogLevel = void 0;
const getConfig_1 = require("./getConfig");
var LogLevel;
(function (LogLevel) {
    LogLevel["DEBUG"] = "debug";
    LogLevel["INFO"] = "info";
    LogLevel["WARN"] = "warn";
    LogLevel["ERROR"] = "error";
})(LogLevel || (exports.LogLevel = LogLevel = {}));
class Logger {
    constructor() {
        this.currentLogLevel = LogLevel.INFO;
    }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
            const logLevel = Object.values(LogLevel).includes((0, getConfig_1.getConfig)('logLevel'))
                ? (0, getConfig_1.getConfig)('logLevel')
                : LogLevel.DEBUG;
            console.log(`Setting log level to ${logLevel}`);
            Logger.instance.setLogLevel(logLevel);
        }
        return Logger.instance;
    }
    setLogLevel(level) {
        this.currentLogLevel = level;
    }
    shouldLog(level) {
        const levels = Object.values(LogLevel);
        return levels.indexOf(level) >= levels.indexOf(this.currentLogLevel);
    }
    formatMessage(message, context) {
        if (!context)
            return message;
        const contextParts = [];
        if (context.operation)
            contextParts.push(`[${context.operation}]`);
        if (context.contentType)
            contextParts.push(`[${context.contentType}]`);
        if (context.documentId)
            contextParts.push(`[${context.documentId}]`);
        if (context.path)
            contextParts.push(`[${context.path.join('.')}]`);
        // Add any additional context keys
        Object.entries(context).forEach(([key, value]) => {
            if (!['operation', 'contentType', 'documentId', 'path'].includes(key)) {
                contextParts.push(`[${key}:${value}]`);
            }
        });
        return `${contextParts.join(' ')} ${message}`;
    }
    log(level, message, context, error) {
        if (!this.shouldLog(level))
            return;
        const formattedMessage = this.formatMessage(message, context);
        const timestamp = new Date().toISOString();
        switch (level) {
            case LogLevel.DEBUG:
                console.debug(`[${timestamp}] 🔍 DEBUG:`, formattedMessage);
                if (error)
                    console.debug(error);
                break;
            case LogLevel.INFO:
                console.info(`[${timestamp}] ℹ️ INFO:`, formattedMessage);
                if (error)
                    console.info(error);
                break;
            case LogLevel.WARN:
                console.warn(`[${timestamp}] ⚠️ WARN:`, formattedMessage);
                if (error)
                    console.warn(error);
                break;
            case LogLevel.ERROR:
                console.error(`[${timestamp}] ❌ ERROR:`, formattedMessage);
                if (error)
                    console.error(error);
                break;
        }
    }
    debug(message, context, error) {
        this.log(LogLevel.DEBUG, message, context, error);
    }
    info(message, context, error) {
        this.log(LogLevel.INFO, message, context, error);
    }
    warn(message, context, error) {
        this.log(LogLevel.WARN, message, context, error);
    }
    error(message, context, error) {
        this.log(LogLevel.ERROR, message, context, error);
    }
}
exports.Logger = Logger;
exports.logger = Logger.getInstance();
