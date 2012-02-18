// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Gvc = imports.gi.Gvc;
const Signals = imports.signals;

const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

const PA_INVALID_INDEX = 0xffffffff; // ((uint32_t) -1)

const VOLUME_NOTIFY_ID = 1;

let indicator = null;
let patcher = null;

function Patcher(indicator) {
    this._init(indicator);
}

Patcher.prototype = {
    _init: function(indicator) {
        this._indicator = indicator;
        this._addOutputId = indicator._control.connect('stream-added',
                                                       Lang.bind(this, this._maybeAddOutput));
        this._addAppId = indicator._control.connect('stream-added',
                                                    Lang.bind(this, this._maybeAddApp));
        this._removeOutputId = indicator._control.connect('stream-removed',
                                                          Lang.bind(this, this._maybeRemoveOutput));
        this._removeAppId = indicator._control.connect('stream-removed',
                                                          Lang.bind(this, this._maybeRemoveApp));
        this._defaultChangeId = indicator._control.connect('default-sink-changed',
                                                           Lang.bind(this, this._setDefault));
        this._outputId = PA_INVALID_INDEX;
        this._volumeMax = indicator._control.get_vol_max_norm();
        this._outputMenus = {};
        this._outputCount = 0;
        this._createAppMenu();
        if (this._indicator._control.get_state() == Gvc.MixerControlState.READY) {
            let defaultOutput = this._indicator._control.get_default_sink();
            if (defaultOutput)
                this._outputId = defaultOutput.id;
            let sinks = this._indicator._control.get_sinks();
            for (let i = 0; i < sinks.length; i++) {
                this._maybeAddOutput(indicator._control, sinks[i].id);
            }
        }
    },

    _createAppMenu: function() {
        this._appMenu = new PopupMenu.PopupSubMenuMenuItem(_('Applications'));
        this._indicator.menu.addMenuItem(this._appMenu, 2);
        this._appCount = 0;
        this._appMenuItems = {};
        this._showHideAppMenu();
    },

    _showHideAppMenu: function() {
        if (this._appCount > 0)
            this._appMenu.actor.show();
        else
            this._appMenu.actor.hide();
    },

    _maybeRemoveApp: function(control, id) {
        if (id in this._appMenuItems) {
            let appMenu = this._appMenuItems[id];
            if (appMenu.volumeId) {
                appMenu.stream.disconnect(appMenu.volumeId);
                appMenu.stream.disconnect(appMenu.mutedId);
                appMenu.volumeId = 0;
                appMenu.mutedId = 0;
            }
            appMenu.label.destroy();
            appMenu.slider.destroy();
            this._appCount--;
            delete this._appMenuItems[id];
            this._showHideAppMenu();
        }
    },

    _maybeAddApp: function(control, id) {
        if (id in this._appMenuItems)
            return;
        let stream = control.lookup_stream_id(id);
        if (stream instanceof Gvc.MixerSinkInput && !stream.is_event_stream) {
            let appMenu = {
                id: id,
                stream: stream,
                label: new PopupMenu.PopupMenuItem(stream.name, { reactive: false }),
                slider: new PopupMenu.PopupSliderMenuItem(0),
            };
            appMenu.slider.connect('value-changed', Lang.bind(this, this._appSliderChanged, appMenu));
            appMenu.slider.connect('drag-end', Lang.bind(this, this._notifyVolumeChange));
            appMenu.volumeId = stream.connect('notify::volume', Lang.bind(this, this._appVolumeChanged, appMenu));
            appMenu.mutedId = stream.connect('notify::is-muted', Lang.bind(this, this._appMutedChanged, appMenu));
            this._appMutedChanged(stream, null, appMenu);
            this._appVolumeChanged(stream, null, appMenu);
            this._appMenu.menu.addMenuItem(appMenu.label);
            this._appMenu.menu.addMenuItem(appMenu.slider);
            this._appMenuItems[id] = appMenu;
            this._appCount++;
            this._showHideAppMenu();
        }
    },

    _appSliderChanged: function(slider, value, appMenu) {
        let volume = value * this._volumeMax;
        let prev_muted = appMenu.stream.is_muted;
        if (volume < 1) {
            appMenu.stream.volume = 0;
            if (!prev_muted)
                appMenu.stream.change_is_muted(true);
        } else {
            appMenu.stream.volume = volume;
            if (prev_muted)
                appMenu.stream.change_is_muted(false);
        }
        appMenu.stream.push_volume();
    },

    _appMutedChanged: function(stream, param_spec, appMenu) {
        let muted = stream.is_muted;
        let slider = appMenu.slider;
        slider.setValue(muted ? 0 : (stream.volume / this._volumeMax));
    },

    _appVolumeChanged: function(stream, param_spec, appMenu) {
        appMenu.slider.setValue(stream.volume / this._volumeMax);
    },

    _maybeAddOutput: function(control, id) {
        if (id in this._outputMenus)
            return;
        let stream = control.lookup_stream_id(id);
        if (stream instanceof Gvc.MixerSink) {
            let menu = new PopupMenu.PopupMenuItem(stream.description);
            menu.connect('activate', Lang.bind(this, function (menuItem, event) {
                if (stream.id != this._outputId)
                    control.set_default_sink(stream);
            }));
            let outputOffset = 2;
            this._indicator.menu.addMenuItem(menu, outputOffset + this._outputCount);
            if (this._outputCount == 1) {
                for (let k in this._outputMenus) {
                    this._outputMenus[k].actor.show();
                }
            }
            this._outputMenus[id] = menu;
            this._outputCount++;
            if (this._outputId == stream.id)
                menu.setShowDot(true);
            if (this._outputCount == 1)
                menu.actor.hide();
        }
    },

    _maybeRemoveOutput: function(control, id) {
        if (id in this._outputMenus) {
            this._outputMenus[id].destroy();
            delete this._outputMenus[id];
            this._outputCount--;
            if (this._outputCount == 1) {
                for (let k in this._outputMenus) {
                    this._outputMenus[k].actor.hide();
                }
            }
        }
    },

    _notifyVolumeChange: function() {
        global.cancel_theme_sound(VOLUME_NOTIFY_ID);
        global.play_theme_sound(VOLUME_NOTIFY_ID, 'audio-volume-change');
    },

    _setDefault: function(control, id) {
        if (this._outputId != id) {
            this._setMenuDots(this._outputId, false);
            this._setMenuDots(id, true);
            this._outputId = id;
        }
    },

    _setMenuDots: function(id, value) {
        if (id in this._outputMenus)
            this._outputMenus[id].setShowDot(value);
    },

    destroy: function() {
        for (let k in this._outputMenus)
            this._outputMenus[k].destroy();
        this._outputMenus = {};
        this._outputCount = 0;
        this._indicator._control.disconnect(this._addOutputId);
        this._indicator._control.disconnect(this._addAppId);
        this._indicator._control.disconnect(this._removeOutputId);
        this._indicator._control.disconnect(this._removeAppId);
        this._indicator._control.disconnect(this._defaultChangeId);
        this.emit('destroy');
    }
};

Signals.addSignalMethods(Patcher.prototype);

function init() {
}

function main() {
}

function enable() {
    if (Main.panel._statusArea['volume'] && !patcher)
        patcher = new Patcher(Main.panel._statusArea['volume']);
}

function disable() {
    if (patcher) {
        patcher.destroy();
        patcher = null;
    }
}
