/*
 * Copyright (C) 2015 Intel Corporation. All rights reserved.
 * Author: Jaakko Hannikainen <jaakko.hannikainen@intel.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const Lang = imports.lang;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Ext = ExtensionUtils.getCurrentExtension();
const Agent = Ext.imports.agent;
const Interface = Ext.imports.interface;
const Logger = Ext.imports.logger;
const Service = Ext.imports.service;
const Technology = Ext.imports.technology;

/* menu with technologies and services */
var Menu = class extends PopupMenu.PopupMenuSection {

    constructor(params) {
        super(params);
        this._technologies = {};
        this._serviceTypes = {};
    }

    hide() {
        this.actor.hide();
    }

    show() {
        this.actor.show();
    }

    _addSorted(technology) {
        let items = this._getMenuItems();
        for(let i = 0; i < items.length; i++) {
            if(items[i].getValue() < technology.getValue())
                continue;
            this.addMenuItem(technology, i);
            return;
        }
        this.addMenuItem(technology);
    }

    addTechnology(path, properties) {
        let type = properties.Type.deep_unpack();
        if(this._technologies[type])
            this.removeTechnology(path);
        let proxy = new Interface.TechnologyProxy(path);
        for(let i in properties)
            properties[i] = properties[i].deep_unpack();
        try {
            this._technologies[type] = Technology.createTechnology(type,
                    properties, proxy, this._manager);
        } catch(error) {
            Logger.logException(error, 'Failed to add technology');
            return;
        }
        this._addSorted(this._technologies[type]);
    }

    /* FIXME: for some reason destroying an item from the menu
     * leaves a hole, but for some reason this fixes it */
    fixMenu() {
        this.addMenuItem(new PopupMenu.PopupMenuItem('Connman'), 0);
        this.firstMenuItem.destroy();
    }

    removeTechnology(path) {
        let type = path.split('/').pop();
        Logger.logInfo('Removing technology ' + type);
        let technology = this._technologies[type];
        if(!technology) {
            Logger.logInfo('Tried to remove unknown technology ' + type);
            return;
        }
        technology.destroy();
        delete this._technologies[type];
        this.fixMenu();
    }

    getService(path) {
        if(!this._serviceTypes[path])
            return null;
        if(!this._technologies[this._serviceTypes[path]])
            return null;
        return this._technologies[this._serviceTypes[path]].getService(path);
    }

    addService(path, properties, indicator) {
        if (!('Type' in properties)) return;
        let type;
        if(properties.Type.deep_unpack) {
            type = properties.Type.deep_unpack();
            if(type == 'vpn') {
                indicator.destroy();
                return;
            }
        }
        else {
            type = 'vpn';
            properties.Type = {deep_unpack: function() {
                return 'vpn';
            }};
        }
        this._serviceTypes[path] = type;

        let proxy;
        if(type != 'vpn')
            proxy = new Interface.ServiceProxy(path);
        else
            proxy = new Interface.ConnectionProxy(path);
        let service = Service.createService(type, proxy, indicator);
        service.update(properties);
        this._technologies[type].addService(path, service);
    }

    updateService(path, properties) {
        if(this._serviceTypes[path]) {
            var type = this._serviceTypes[path];
            this._technologies[type].updateService(path, properties);
            return;
        } else
            this.addService(path, properties);
    }

    removeService(path) {
        if(!this._serviceTypes[path]) {
            log('Tried to remove unknown service ' + path);
            return;
        }
        if(this._technologies[this._serviceTypes[path]]) {
            log('Removing service ' + path);
            this._technologies[this._serviceTypes[path]].removeService(path);
        }
        delete this._serviceTypes[path];
        this.fixMenu();
    }

    clear() {
        for(let type in this._technologies) {
            try {
                if(type != "vpn") {
                    this._technologies[type].destroy();
                    delete this._technologies[type];
                }
            } catch(error) {
                Logger.logException(error, 'Failed to clear technology ' + type);
            }
        }
    }

    vpnClear() {
        if(!this._technologies["vpn"])
            return;
        try {
            this._technologies["vpn"].destroy();
            delete this._technologies["vpn"];
        } catch(error) {
            Logger.logException(error, 'Failed to clear VPN connections');
        }
    }
};

/* main applet class handling everything */
var Applet = GObject.registerClass(class Applet extends PanelMenu.SystemIndicator {

    _init() {
        super._init();

        this._menu = new Menu();
        this.menu.addMenuItem(this._menu);
        this.menu.actor.show();

        log('Enabling Connman applet');
        this._watch = Gio.DBus.system.watch_name(Interface.BUS_NAME,
                Gio.BusNameWatcherFlags.NONE,
                this._connectEvent.bind(this),
                this._disconnectEvent.bind(this));
        this._vpnwatch = Gio.DBus.system.watch_name(Interface.VPN_BUS_NAME,
                Gio.BusNameWatcherFlags.NONE,
                this._vpnConnectEvent.bind(this),
                this._vpnDisconnectEvent.bind(this));
    }

    _addIndicator() {
        let indicator = super._addIndicator();
        indicator.hide();
        return indicator;
    }

    _updateService(path, properties) {
        if(path.indexOf("service/vpn") != -1)
            return;
        if(this._menu.getService(path))
            this._menu.updateService(path, properties);
        else
            this._menu.addService(path, properties, this._addIndicator());
    }

    _updateAllServices() {
        this._manager.GetServicesRemote(function(result, exception) {
            if(!result || exception) {
                Logger.logError('Error fetching services: ' + exception);
                return;
            }
            let services = result[0];
            for (var o of services)
                this._updateService(o[0], o[1]);

        }.bind(this));
    }

    _updateAllTechnologies() {
        this._menu.clear();
        this._manager.GetTechnologiesRemote(function(result, exception) {
            if(!result || exception) {
                Logger.logError('Error fetching technologies: ' + exception);
                return;
            }
            let technologies = result[0];
            for (var o of technologies)
                this._menu.addTechnology(o[0], o[1]);
            this._updateAllServices();
        }.bind(this));
    }

    _updateAllConnections() {
        this._menu.vpnClear();

        this._menu._technologies['vpn'] = Technology.createTechnology('vpn',
                {Powered: true});
        this._menu.addMenuItem(this._menu._technologies['vpn']);

        this._vpnManager.GetConnectionsRemote(function(result, exception) {
            if(!result || exception) {
                Logger.logError('Error fetching VPN connections: ' + exception);
                return;
            }
            let connections = result[0];
            for (var o of connections) {
                o[1]['Type'] = 'vpn';
                this._menu.addService(o[0], o[1], this._addIndicator());
            }
        }.bind(this));
    }

    _updateVisibility() {
        if(this._manager || this._vpnManager) {
            this.menu.actor.show();
            //this.indicators.show();
        }
        else {
            this.menu.actor.hide();
            //this.indicators.hide();
        }
    }

    _connectEvent() {
        Logger.logInfo('Connected to Connman');

        this._manager = new Interface.ManagerProxy();
        this._menu._manager = this._manager;
        this._agent = new Agent.Agent();

        this._manager.RegisterAgentRemote(Interface.AGENT_PATH);
        this._asig = this._manager.connectSignal('TechnologyAdded',
            function(proxy, sender, o) {
                try {
                    this._menu.addTechnology(o[0], o[1]);
                } catch(error) {
                    Logger.logException(error);
                }
            }.bind(this));
        this._rsig = this._manager.connectSignal('TechnologyRemoved',
            function(proxy, sender, [path, properties]) {
                this._menu.removeTechnology(path);
            }.bind(this));
        this._psig = this._manager.connectSignal('PropertyChanged',
            function(proxy, sender, [property, value]) {
                Logger.logDebug('Global property ' + property +
                    ' changed: ' + value.deep_unpack());
            }.bind(this));
        this._ssig = this._manager.connectSignal('ServicesChanged',
            function(proxy, sender, [changed, removed]) {
                try {
                    for (var o of changed)
                        this._updateService(o[0], o[1]);
                    for (var path of removed)
                        this._menu.removeService(path);
                } catch(error) {
                    Logger.logException(error);
                }
            }.bind(this));

        this._updateAllTechnologies();
        this._updateVisibility();
    }

    _vpnConnectEvent() {
        this._vpnManager = new Interface.VPNManagerProxy();
        this._vpnAgent = new Agent.VPNAgent();
        this._vpnManager.RegisterAgentRemote(Interface.VPN_AGENT_PATH);
        this._updateVisibility();

        this._vasig = this._vpnManager.connectSignal('ConnectionAdded',
            function(proxy, sender, [path, properties]) {
                try {
                    properties['Type'] = 'vpn';
                    this._menu.addService(path, properties, this._addIndicator());
                } catch(error) {
                    Logger.logException(error);
                }
            }.bind(this));
        this._vrsig = this._vpnManager.connectSignal('ConnectionRemoved',
            function(proxy, sender, [path, properties]) {
                this._menu.removeService(path);
            }.bind(this));

        this._updateAllConnections();
    }

    _vpnDisconnectEvent() {
        let signals = [this._vasig, this._vrsig];
        if(this._vpnManager) {
            Logger.logDebug('Disconnecting vpn signals');
            for(let signalId in signals) {
                try {
                    Logger.logDebug('Disconnecting signal ' + signals[signalId]);
                    this._vpnManager.disconnectSignal(signals[signalId]);
                } catch(error) {
                    Logger.logException(error, 'Failed to disconnect signal');
                }
            }
        }
        try {
            if(this._vpnManager)
                this._vpnManager.UnregisterAgentRemote(Interface.VPN_AGENT_PATH);
        } catch(error) {
            Logger.logException(error, 'Failed to unregister vpn agent');
        }
        this._vpnManager = null;
        if(this._vpnAgent)
            this._vpnAgent.destroy();
        this.vpnAgent = null;
        this._updateVisibility();
    }

    _disconnectEvent() {
        Logger.logInfo('Disconnected from Connman');
        this._menu.clear();
        this._menu._manager = null;
        let signals = [this._asig, this._rsig, this._ssig, this._psig];
        if(this._manager) {
            Logger.logDebug('Disconnecting signals');
            for(let signalId in signals) {
                try {
                    Logger.logDebug('Disconnecting signal ' + signals[signalId]);
                    this._manager.disconnectSignal(signals[signalId]);
                } catch(error) {
                    Logger.logException(error, 'Failed to disconnect signal');
                }
            }
        }
        try {
            this._manager.UnregisterAgentRemote(Interface.AGENT_PATH);
        } catch(error) {
        }
        this._manager = null;
        if(this._agent)
            this._agent.destroy();
        this._agent = null;
        this._updateVisibility();
    }

    destroy() {
        Logger.logInfo('Destroying Connman applet');
        this._disconnectEvent();
        this._menu.clear();
        //this.indicators.destroy();
        this.menu.actor.destroy();
        if(this._watch)
            Gio.DBus.system.unwatch_name(this._watch);
        if(this._vpnwatch)
            Gio.DBus.system.unwatch_name(this._vpnwatch);
        if(this._agent)
            this._agent.destroy();
        if(this._vpnAgent)
            this._vpnAgent.destroy();
        this._agent = null;
        this._vpnAgent = null;
        this._watch = null;
    }
});
