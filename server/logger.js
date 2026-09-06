const { createLogger, format, transports } = require('winston');

const SPLAT = Symbol.for('splat');

/** Render whatever was passed as an extra log argument as readable text. */
const describe = (value) => {
    if (value instanceof Error) {
        // A failed socket connect arrives as an AggregateError whose own message
        // is empty — the reason lives in `errors`.
        const detail = Array.isArray(value.errors)
            ? value.errors.map((e) => e.message || e.code).filter(Boolean).join('; ')
            : '';
        return [value.message || value.code || value.name, detail].filter(Boolean).join(' ');
    }
    if (value && typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
};

/**
 * winston drops arguments after the first unless they are printf placeholders,
 * which is how `logger.error("[Redis] error:", err.message)` printed a bare
 * prefix and nothing else. Fold them into the message instead.
 */
const appendSplat = format((info) => {
    const rest = info[SPLAT];
    if (!Array.isArray(rest) || rest.length === 0) return info;

    // winston already folds an Error's own message in and merges its properties
    // into the record (which `simple()` would then dump as JSON), so skip text
    // that is already there and drop the merged fields.
    const extra = rest
        .map(describe)
        .filter((text) => text && !String(info.message).includes(text));
    if (extra.length) {
        info.message = [info.message, ...extra].join(' ');
    }
    for (const value of rest) {
        if (value && typeof value === 'object') {
            for (const key of Object.keys(value)) delete info[key];
            delete info.stack;
        }
    }
    return info;
});

const logger = createLogger({
    format: format.combine(
        appendSplat(),
        format.colorize(),
        format.simple(),
    ),
    transports: [new transports.Console()]
});

module.exports = logger;
