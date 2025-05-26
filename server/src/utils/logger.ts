import { getConfig } from './getConfig';

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

interface LogContext {
  operation?: string;
  contentType?: string;
  documentId?: string;
  path?: string[];
  [key: string]: any;
}

export class Logger {
  private static instance: Logger;
  private currentLogLevel: LogLevel = LogLevel.INFO;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
      const logLevel = Object.values(LogLevel).includes(getConfig('logLevel'))
        ? getConfig('logLevel')
        : LogLevel.DEBUG;
      console.log(`Setting log level to ${logLevel}`);
      Logger.instance.setLogLevel(logLevel);
    }
    return Logger.instance;
  }

  setLogLevel(level: LogLevel) {
    this.currentLogLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = Object.values(LogLevel);
    return levels.indexOf(level) >= levels.indexOf(this.currentLogLevel);
  }

  private formatMessage(message: string, context?: LogContext): string {
    if (!context) return message;

    const contextParts = [];
    if (context.operation) contextParts.push(`[${context.operation}]`);
    if (context.contentType) contextParts.push(`[${context.contentType}]`);
    if (context.documentId) contextParts.push(`[${context.documentId}]`);
    if (context.path) contextParts.push(`[${context.path.join('.')}]`);

    // Add any additional context keys
    Object.entries(context).forEach(([key, value]) => {
      if (!['operation', 'contentType', 'documentId', 'path'].includes(key)) {
        contextParts.push(`[${key}:${value}]`);
      }
    });

    return `${contextParts.join(' ')} ${message}`;
  }

  private log(level: LogLevel, message: string, context?: LogContext, error?: any) {
    if (!this.shouldLog(level)) return;

    const formattedMessage = this.formatMessage(message, context);
    const timestamp = new Date().toISOString();

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(`[${timestamp}] 🔍 DEBUG:`, formattedMessage);
        if (error) console.debug(error);
        break;
      case LogLevel.INFO:
        console.info(`[${timestamp}] ℹ️ INFO:`, formattedMessage);
        if (error) console.info(error);
        break;
      case LogLevel.WARN:
        console.warn(`[${timestamp}] ⚠️ WARN:`, formattedMessage);
        if (error) console.warn(error);
        break;
      case LogLevel.ERROR:
        console.error(`[${timestamp}] ❌ ERROR:`, formattedMessage);
        if (error) console.error(error);
        break;
    }
  }

  debug(message: string, context?: LogContext, error?: any) {
    this.log(LogLevel.DEBUG, message, context, error);
  }

  info(message: string, context?: LogContext, error?: any) {
    this.log(LogLevel.INFO, message, context, error);
  }

  warn(message: string, context?: LogContext, error?: any) {
    this.log(LogLevel.WARN, message, context, error);
  }

  error(message: string, context?: LogContext, error?: any) {
    this.log(LogLevel.ERROR, message, context, error);
  }
}

export const logger = Logger.getInstance();
