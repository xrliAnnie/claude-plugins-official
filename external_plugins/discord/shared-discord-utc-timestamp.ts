const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function assertUtcIsoTimestamp(value: string, field: string): void {
	if (!UTC_ISO_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${field} must be a valid UTC ISO timestamp ending in Z`);
	}
}

