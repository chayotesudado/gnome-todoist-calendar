import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Token from './lib/token.js';

const TOKEN_URL = 'https://app.todoist.com/app/settings/integrations/developer';

export default class TodoistCalendarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.search_enabled = false;

        const page = new Adw.PreferencesPage({title: _('Todoist Calendar'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // Tell the running extension to re-read the token.
        const bump = () => settings.set_uint('token-serial', settings.get_uint('token-serial') + 1);
        const toast = title => window.add_toast(new Adw.Toast({title}));

        // ---- account
        const account = new Adw.PreferencesGroup({
            title: _('Todoist'),
            description: _('The date menu reads and completes your Todoist tasks with your Todoist API token, kept in the login keyring. Planify and other Todoist apps see the changes on their next sync.'),
        });
        page.add(account);

        const status = new Adw.ActionRow({title: _('API Token')});
        const remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        status.add_suffix(remove);
        account.add(status);

        const sync = async () => {
            let token = null;
            try {
                token = await Token.lookup();
            } catch (e) {
                status.subtitle = _('Couldn’t open the keyring');
                remove.visible = false;
                return;
            }
            status.subtitle = token ? _('Saved in the keyring') : _('Not set');
            remove.visible = Boolean(token);
        };
        sync();

        remove.connect('clicked', async () => {
            try {
                await Token.clear();
                bump();
                toast(_('Token removed'));
            } catch (e) {
                toast(_('Couldn’t remove the token'));
            }
            sync();
        });

        const entry = new Adw.PasswordEntryRow({title: _('New API Token'), show_apply_button: true});
        entry.connect('apply', async () => {
            const token = entry.text.trim();
            if (!token)
                return;
            try {
                await Token.store(token);
                entry.text = '';
                bump();
                toast(_('Token saved'));
            } catch (e) {
                toast(_('Couldn’t save the token'));
            }
            sync();
        });
        account.add(entry);

        const help = new Adw.ActionRow({
            title: _('Find Your API Token'),
            subtitle: _('Todoist › Settings › Integrations › Developer'),
            activatable: true,
        });
        help.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        help.connect('activated', () => new Gtk.UriLauncher({uri: TOKEN_URL}).launch(window, null, null));
        account.add(help);

        // ---- list
        const list = new Adw.PreferencesGroup({title: _('Date Menu')});
        page.add(list);

        const overdue = new Adw.SwitchRow({
            title: _('Show Overdue Tasks'),
            subtitle: _('Listed first on today, as in Todoist’s Today view'),
        });
        settings.bind('show-overdue', overdue, 'active', 0);
        list.add(overdue);

        const minutes = new Adw.SpinRow({
            title: _('Refresh Every'),
            subtitle: _('Minutes. Opening the menu also refreshes, at most every 30 seconds.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-minutes', minutes, 'value', 0);
        list.add(minutes);
    }
}
