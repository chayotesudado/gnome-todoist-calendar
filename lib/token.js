import Secret from 'gi://Secret';

// The Todoist API token lives in GNOME Keyring (the login keyring), never in
// GSettings. Preferences stores it; the extension only reads it.

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.todoist-calendar',
    Secret.SchemaFlags.NONE,
    {service: Secret.SchemaAttributeType.STRING});
const ATTRS = {service: 'todoist'};

export function lookup(cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, ATTRS, cancellable, (_s, res) => {
            try {
                resolve(Secret.password_lookup_finish(res) || null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function store(token) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, ATTRS, Secret.COLLECTION_DEFAULT,
            'Todoist API token (Todoist Calendar)', token, null, (_s, res) => {
                try {
                    resolve(Secret.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function clear() {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, ATTRS, null, (_s, res) => {
            try {
                resolve(Secret.password_clear_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}
