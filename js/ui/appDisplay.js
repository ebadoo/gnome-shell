// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported AppDisplay, AppSearchProvider */

const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const Signals = imports.signals;

const AppFavorites = imports.ui.appFavorites;
const BoxPointer = imports.ui.boxpointer;
const DND = imports.ui.dnd;
const GrabHelper = imports.ui.grabHelper;
const IconGrid = imports.ui.iconGrid;
const Main = imports.ui.main;
const PageIndicators = imports.ui.pageIndicators;
const PopupMenu = imports.ui.popupMenu;
const Search = imports.ui.search;
const Params = imports.misc.params;
const Util = imports.misc.util;
const SystemActions = imports.misc.systemActions;

const { loadInterfaceXML } = imports.misc.fileUtils;

var MENU_POPUP_TIMEOUT = 600;
var MAX_COLUMNS = 6;
var MIN_COLUMNS = 4;
var MIN_ROWS = 4;

var INACTIVE_GRID_OPACITY = 77;
// This time needs to be less than IconGrid.EXTRA_SPACE_ANIMATION_TIME
// to not clash with other animations
var INACTIVE_GRID_OPACITY_ANIMATION_TIME = 240;
var FOLDER_SUBICON_FRACTION = .4;

var MIN_FREQUENT_APPS_COUNT = 3;

var VIEWS_SWITCH_TIME = 400;
var VIEWS_SWITCH_ANIMATION_DELAY = 100;

var PAGE_SWITCH_TIME = 300;

var APP_ICON_SCALE_IN_TIME = 500;
var APP_ICON_SCALE_IN_DELAY = 700;

const SWITCHEROO_BUS_NAME = 'net.hadess.SwitcherooControl';
const SWITCHEROO_OBJECT_PATH = '/net/hadess/SwitcherooControl';

const SwitcherooProxyInterface = loadInterfaceXML('net.hadess.SwitcherooControl');
const SwitcherooProxy = Gio.DBusProxy.makeProxyWrapper(SwitcherooProxyInterface);
let discreteGpuAvailable = false;

function _getCategories(info) {
    let categoriesStr = info.get_categories();
    if (!categoriesStr)
        return [];
    return categoriesStr.split(';');
}

function _listsIntersect(a, b) {
    for (let itemA of a)
        if (b.includes(itemA))
            return true;
    return false;
}

function _getFolderName(folder) {
    let name = folder.get_string('name');

    if (folder.get_boolean('translate')) {
        let keyfile = new GLib.KeyFile();
        let path = 'desktop-directories/' + name;

        try {
            keyfile.load_from_data_dirs(path, GLib.KeyFileFlags.NONE);
            name = keyfile.get_locale_string('Desktop Entry', 'Name', null);
        } catch (e) {
            return name;
        }
    }

    return name;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function _getViewFromIcon(icon) {
    let parent = icon.actor.get_parent();
    if (!parent._delegate || !(parent._delegate instanceof BaseAppView))
        return null;
    return parent._delegate;
}

function _findBestFolderName(apps) {
    let appInfos = apps.map(app => app.get_app_info());

    let categoryCounter = {};
    let commonCategories = [];

    appInfos.reduce((categories, appInfo) => {
        for (let category of appInfo.get_categories().split(';')) {
            if (!(category in categoryCounter))
                categoryCounter[category] = 0;

            categoryCounter[category] += 1;

            // If a category is present in all apps, its counter will
            // reach appInfos.length
            if (category.length > 0 &&
                categoryCounter[category] == appInfos.length) {
                categories.push(category);
            }
        }
        return categories;
    }, commonCategories);

    for (let category of commonCategories) {
        let keyfile = new GLib.KeyFile();
        let path = 'desktop-directories/%s.directory'.format(category);

        try {
            keyfile.load_from_data_dirs(path, GLib.KeyFileFlags.NONE);
            return keyfile.get_locale_string('Desktop Entry', 'Name', null);
        } catch (e) {
            continue;
        }
    }

    return null;
}

class BaseAppView {
    constructor(params, gridParams) {
        if (this.constructor === BaseAppView)
            throw new TypeError(`Cannot instantiate abstract class ${this.constructor.name}`);

        gridParams = Params.parse(gridParams, { xAlign: St.Align.MIDDLE,
                                                columnLimit: MAX_COLUMNS,
                                                minRows: MIN_ROWS,
                                                minColumns: MIN_COLUMNS,
                                                fillParent: false,
                                                padWithSpacing: true });
        params = Params.parse(params, { usePagination: false });

        if (params.usePagination)
            this._grid = new IconGrid.PaginatedIconGrid(gridParams);
        else
            this._grid = new IconGrid.IconGrid(gridParams);

        this._grid.connect('child-focused', (grid, actor) => {
            this._childFocused(actor);
        });
        // Standard hack for ClutterBinLayout
        this._grid.x_expand = true;

        this._items = {};
        this._allItems = [];
    }

    _childFocused(_actor) {
        // Nothing by default
    }

    _redisplay() {
        let oldApps = this._allItems.slice();
        let oldAppIds = oldApps.map(icon => icon.id);

        let newApps = this._loadApps().sort(this._compareItems);
        let newAppIds = newApps.map(icon => icon.id);

        let addedApps = newApps.filter(icon => !oldAppIds.includes(icon.id));
        let removedApps = oldApps.filter(icon => !newAppIds.includes(icon.id));

        // Remove old app icons
        removedApps.forEach(icon => {
            let iconIndex = this._allItems.indexOf(icon);

            this._allItems.splice(iconIndex, 1);
            this._grid.removeItem(icon);
            delete this._items[icon.id];
        });

        // Add new app icons
        addedApps.forEach(icon => {
            let iconIndex = newApps.indexOf(icon);

            this._allItems.splice(iconIndex, 0, icon);
            this._grid.addItem(icon, iconIndex);
            this._items[icon.id] = icon;
        });

        this.emit('view-loaded');
    }

    getAllItems() {
        return this._allItems;
    }

    _compareItems(a, b) {
        return a.name.localeCompare(b.name);
    }

    _selectAppInternal(id) {
        if (this._items[id])
            this._items[id].actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        else
            log(`No such application ${id}`);
    }

    selectApp(id) {
        if (this._items[id] && this._items[id].actor.mapped) {
            this._selectAppInternal(id);
        } else if (this._items[id]) {
            // Need to wait until the view is mapped
            let signalId = this._items[id].actor.connect('notify::mapped',
                actor => {
                    if (actor.mapped) {
                        actor.disconnect(signalId);
                        this._selectAppInternal(id);
                    }
                });
        } else {
            // Need to wait until the view is built
            let signalId = this.connect('view-loaded', () => {
                this.disconnect(signalId);
                this.selectApp(id);
            });
        }
    }

    _doSpringAnimation(animationDirection) {
        this._grid.opacity = 255;
        this._grid.animateSpring(animationDirection,
                                 Main.overview.getShowAppsButton());
    }

    animate(animationDirection, onComplete) {
        if (onComplete) {
            let animationDoneId = this._grid.connect('animation-done', () => {
                this._grid.disconnect(animationDoneId);
                onComplete();
            });
        }

        if (animationDirection == IconGrid.AnimationDirection.IN) {
            let id = this._grid.connect('paint', () => {
                this._grid.disconnect(id);
                this._doSpringAnimation(animationDirection);
            });
        } else {
            this._doSpringAnimation(animationDirection);
        }
    }

    animateSwitch(animationDirection) {
        this.actor.remove_all_transitions();
        this._grid.remove_all_transitions();

        let params = {
            duration: VIEWS_SWITCH_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        };
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this.actor.show();
            params.opacity = 255;
            params.delay = VIEWS_SWITCH_ANIMATION_DELAY;
        } else {
            params.opacity = 0;
            params.delay = 0;
            params.onComplete = () => this.actor.hide();
        }

        this._grid.ease(params);
    }
}
Signals.addSignalMethods(BaseAppView.prototype);

var AllView = class AllView extends BaseAppView {
    constructor() {
        super({ usePagination: true }, null);
        this._scrollView = new St.ScrollView({ style_class: 'all-apps',
                                               x_expand: true,
                                               y_expand: true,
                                               x_fill: true,
                                               y_fill: false,
                                               reactive: true,
                                               y_align: St.Align.START });
        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });
        this.actor.add_actor(this._scrollView);
        this._grid._delegate = this;

        this._scrollView.set_policy(St.PolicyType.NEVER,
                                    St.PolicyType.EXTERNAL);
        this._adjustment = this._scrollView.vscroll.adjustment;

        this._pageIndicators = new PageIndicators.AnimatedPageIndicators();
        this._pageIndicators.connect('page-activated',
            (indicators, pageIndex) => {
                this.goToPage(pageIndex);
            });
        this._pageIndicators.connect('scroll-event', this._onScroll.bind(this));
        this.actor.add_actor(this._pageIndicators);

        this.folderIcons = [];

        this._stack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        let box = new St.BoxLayout({ vertical: true });

        this._grid.currentPage = 0;
        this._stack.add_actor(this._grid);
        this._eventBlocker = new St.Widget({ x_expand: true, y_expand: true });
        this._stack.add_actor(this._eventBlocker);

        box.add_actor(this._stack);
        this._scrollView.add_actor(box);

        this._scrollView.connect('scroll-event', this._onScroll.bind(this));

        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', this._onPan.bind(this));
        panAction.connect('gesture-cancel', this._onPanEnd.bind(this));
        panAction.connect('gesture-end', this._onPanEnd.bind(this));
        this._panAction = panAction;
        this._scrollView.add_action(panAction);
        this._panning = false;
        this._clickAction = new Clutter.ClickAction();
        this._clickAction.connect('clicked', () => {
            if (!this._currentPopup)
                return;

            let [x, y] = this._clickAction.get_coords();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
            if (!this._currentPopup.actor.contains(actor))
                this._currentPopup.popdown();
        });
        this._eventBlocker.add_action(this._clickAction);

        this._displayingPopup = false;
        this._currentPopupDestroyId = 0;

        this._availWidth = 0;
        this._availHeight = 0;

        Main.overview.connect('hidden', () => this.goToPage(0));
        this._grid.connect('space-opened', () => {
            let fadeEffect = this._scrollView.get_effect('fade');
            if (fadeEffect)
                fadeEffect.enabled = false;

            this.emit('space-ready');
        });
        this._grid.connect('space-closed', () => {
            this._displayingPopup = false;
        });

        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped) {
                this._keyPressEventId =
                    global.stage.connect('key-press-event',
                                         this._onKeyPressEvent.bind(this));
            } else {
                if (this._keyPressEventId)
                    global.stage.disconnect(this._keyPressEventId);
                this._keyPressEventId = 0;
            }
        });

        this._redisplayWorkId = Main.initializeDeferredWork(this.actor, this._redisplay.bind(this));

        Shell.AppSystem.get_default().connect('installed-changed', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });
        this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
        this._folderSettings.connect('changed::folder-children', () => {
            Main.queueDeferredWork(this._redisplayWorkId);
        });

        Main.overview.connect('item-drag-begin', this._onDragBegin.bind(this));
        Main.overview.connect('item-drag-end', this._onDragEnd.bind(this));

        this._nEventBlockerInhibits = 0;
    }

    _redisplay() {
        super._redisplay();
        this._refilterApps();
    }

    _itemNameChanged(item) {
        // If an item's name changed, we can pluck it out of where it's
        // supposed to be and reinsert it where it's sorted.
        let oldIdx = this._allItems.indexOf(item);
        this._allItems.splice(oldIdx, 1);
        let newIdx = Util.insertSorted(this._allItems, item, this._compareItems);

        this._grid.removeItem(item);
        this._grid.addItem(item, newIdx);
    }

    _refilterApps() {
        let filteredApps = this._allItems.filter(icon => !icon.actor.visible);

        this._allItems.forEach(icon => {
            if (icon instanceof AppIcon)
                icon.actor.visible = true;
        });

        this.folderIcons.forEach(folder => {
            let folderApps = folder.getAppIds();
            folderApps.forEach(appId => {
                let appIcon = this._items[appId];
                appIcon.actor.visible = false;
            });
        });

        // Scale in app icons that weren't visible, but now are
        filteredApps.filter(icon => icon.actor.visible).forEach(icon => {
            if (icon instanceof AppIcon)
                icon.scaleIn();
        });
    }

    getAppInfos() {
        return this._appInfoList;
    }

    _loadApps() {
        let newApps = [];
        this._appInfoList = Shell.AppSystem.get_default().get_installed().filter(appInfo => {
            try {
                (appInfo.get_id()); // catch invalid file encodings
            } catch (e) {
                return false;
            }
            return appInfo.should_show();
        });

        let apps = this._appInfoList.map(app => app.get_id());

        let appSys = Shell.AppSystem.get_default();

        this.folderIcons = [];

        let folders = this._folderSettings.get_strv('folder-children');
        folders.forEach(id => {
            let path = this._folderSettings.path + 'folders/' + id + '/';
            let icon = this._items[id];
            if (!icon) {
                icon = new FolderIcon(id, path, this);
                icon.connect('name-changed', this._itemNameChanged.bind(this));
                icon.connect('apps-changed', this._redisplay.bind(this));
            }
            newApps.push(icon);
            this.folderIcons.push(icon);
        });

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        let favoritesWritable = global.settings.is_writable('favorite-apps');

        apps.forEach(appId => {
            let app = appSys.lookup_app(appId);

            let icon = new AppIcon(app,
                                   { isDraggable: favoritesWritable });
            newApps.push(icon);
        });

        return newApps;
    }

    // Overridden from BaseAppView
    animate(animationDirection, onComplete) {
        this._scrollView.reactive = false;
        let completionFunc = () => {
            this._scrollView.reactive = true;
            if (onComplete)
                onComplete();
        };

        if (animationDirection == IconGrid.AnimationDirection.OUT &&
            this._displayingPopup && this._currentPopup) {
            this._currentPopup.popdown();
            let spaceClosedId = this._grid.connect('space-closed', () => {
                this._grid.disconnect(spaceClosedId);
                super.animate(animationDirection, completionFunc);
            });
        } else {
            super.animate(animationDirection, completionFunc);
            if (animationDirection == IconGrid.AnimationDirection.OUT)
                this._pageIndicators.animateIndicators(animationDirection);
        }
    }

    animateSwitch(animationDirection) {
        super.animateSwitch(animationDirection);

        if (this._currentPopup && this._displayingPopup &&
            animationDirection == IconGrid.AnimationDirection.OUT)
            this._currentPopup.actor.ease({
                opacity: 0,
                duration: VIEWS_SWITCH_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => (this.opacity = 255)
            });

        if (animationDirection == IconGrid.AnimationDirection.OUT)
            this._pageIndicators.animateIndicators(animationDirection);
    }

    getCurrentPageY() {
        return this._grid.getPageY(this._grid.currentPage);
    }

    goToPage(pageNumber) {
        pageNumber = clamp(pageNumber, 0, this._grid.nPages() - 1);

        if (this._grid.currentPage == pageNumber && this._displayingPopup && this._currentPopup)
            return;
        if (this._displayingPopup && this._currentPopup)
            this._currentPopup.popdown();

        if (!this.actor.mapped) {
            this._adjustment.value = this._grid.getPageY(pageNumber);
            this._pageIndicators.setCurrentPage(pageNumber);
            this._grid.currentPage = pageNumber;
            return;
        }

        let velocity;
        if (!this._panning)
            velocity = 0;
        else
            velocity = Math.abs(this._panAction.get_velocity(0)[2]);
        // Tween the change between pages.
        // If velocity is not specified (i.e. scrolling with mouse wheel),
        // use the same speed regardless of original position
        // if velocity is specified, it's in pixels per milliseconds
        let diffToPage = this._diffToPage(pageNumber);
        let childBox = this._scrollView.get_allocation_box();
        let totalHeight = childBox.y2 - childBox.y1;
        let time;
        // Only take the velocity into account on page changes, otherwise
        // return smoothly to the current page using the default velocity
        if (this._grid.currentPage != pageNumber) {
            let minVelocity = totalHeight / PAGE_SWITCH_TIME;
            velocity = Math.max(minVelocity, velocity);
            time = diffToPage / velocity;
        } else {
            time = PAGE_SWITCH_TIME * diffToPage / totalHeight;
        }
        // When changing more than one page, make sure to not take
        // longer than PAGE_SWITCH_TIME
        time = Math.min(time, PAGE_SWITCH_TIME);

        this._grid.currentPage = pageNumber;
        this._adjustment.ease(this._grid.getPageY(pageNumber), {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: time
        });

        this._pageIndicators.setCurrentPage(pageNumber);
    }

    _diffToPage(pageNumber) {
        let currentScrollPosition = this._adjustment.value;
        return Math.abs(currentScrollPosition - this._grid.getPageY(pageNumber));
    }

    openSpaceForPopup(item, side, nRows) {
        this._updateIconOpacities(true);
        this._displayingPopup = true;
        this._grid.openExtraSpace(item, side, nRows);
    }

    _closeSpaceForPopup() {
        this._updateIconOpacities(false);

        let fadeEffect = this._scrollView.get_effect('fade');
        if (fadeEffect)
            fadeEffect.enabled = true;

        this._grid.closeExtraSpace();
    }

    _onScroll(actor, event) {
        if (this._displayingPopup || !this._scrollView.reactive)
            return Clutter.EVENT_STOP;

        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP)
            this.goToPage(this._grid.currentPage - 1);
        else if (direction == Clutter.ScrollDirection.DOWN)
            this.goToPage(this._grid.currentPage + 1);

        return Clutter.EVENT_STOP;
    }

    _onPan(action) {
        if (this._displayingPopup)
            return false;
        this._panning = true;
        this._clickAction.release();
        let [dist_, dx_, dy] = action.get_motion_delta(0);
        let adjustment = this._adjustment;
        adjustment.value -= (dy / this._scrollView.height) * adjustment.page_size;
        return false;
    }

    _onPanEnd(action) {
        if (this._displayingPopup)
            return;

        let pageHeight = this._grid.getPageHeight();

        // Calculate the scroll value we'd be at, which is our current
        // scroll plus any velocity the user had when they released
        // their finger.

        let velocity = -action.get_velocity(0)[2];
        let endPanValue = this._adjustment.value + velocity;

        let closestPage = Math.round(endPanValue / pageHeight);
        this.goToPage(closestPage);

        this._panning = false;
    }

    _onKeyPressEvent(actor, event) {
        if (this._displayingPopup)
            return Clutter.EVENT_STOP;

        if (event.get_key_symbol() == Clutter.Page_Up) {
            this.goToPage(this._grid.currentPage - 1);
            return Clutter.EVENT_STOP;
        } else if (event.get_key_symbol() == Clutter.Page_Down) {
            this.goToPage(this._grid.currentPage + 1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    addFolderPopup(popup) {
        this._stack.add_actor(popup.actor);
        popup.connect('open-state-changed', (popup, isOpen) => {
            this._eventBlocker.reactive = isOpen;

            if (this._currentPopup) {
                this._currentPopup.actor.disconnect(this._currentPopupDestroyId);
                this._currentPopupDestroyId = 0;
            }

            this._currentPopup = null;

            if (isOpen) {
                this._currentPopup = popup;
                this._currentPopupDestroyId = popup.actor.connect('destroy', () => {
                    this._currentPopup = null;
                    this._currentPopupDestroyId = 0;
                    this._eventBlocker.reactive = false;
                });
            }
            this._updateIconOpacities(isOpen);
            if (!isOpen)
                this._closeSpaceForPopup();
        });
    }

    _childFocused(icon) {
        let itemPage = this._grid.getItemPage(icon);
        this.goToPage(itemPage);
    }

    _updateIconOpacities(folderOpen) {
        for (let id in this._items) {
            let opacity;
            if (folderOpen && !this._items[id].actor.checked)
                opacity =  INACTIVE_GRID_OPACITY;
            else
                opacity = 255;
            this._items[id].actor.ease({
                opacity: opacity,
                duration: INACTIVE_GRID_OPACITY_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
    }

    // Called before allocation to calculate dynamic spacing
    adaptToSize(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = 0;
        box.x2 = width;
        box.y1 = 0;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._scrollView.get_theme_node().get_content_box(box);
        box = this._grid.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        let oldNPages = this._grid.nPages();

        this._grid.adaptToSize(availWidth, availHeight);

        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this._scrollView.update_fade_effect(fadeOffset, 0);
        if (fadeOffset > 0)
            this._scrollView.get_effect('fade').fade_edges = true;

        if (this._availWidth != availWidth || this._availHeight != availHeight || oldNPages != this._grid.nPages()) {
            Meta.later_add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._adjustment.value = 0;
                this._grid.currentPage = 0;
                this._pageIndicators.setNPages(this._grid.nPages());
                this._pageIndicators.setCurrentPage(0);
                return GLib.SOURCE_REMOVE;
            });
        }

        this._availWidth = availWidth;
        this._availHeight = availHeight;
        // Update folder views
        for (let i = 0; i < this.folderIcons.length; i++)
            this.folderIcons[i].adaptToSize(availWidth, availHeight);
    }

    _handleDragOvershoot(dragEvent) {
        let [, gridY] = this.actor.get_transformed_position();
        let [, gridHeight] = this.actor.get_transformed_size();
        let gridBottom = gridY + gridHeight;

        // Within the grid boundaries, or already animating
        if (dragEvent.y > gridY && dragEvent.y < gridBottom ||
            this._adjustment.get_transition('value') != null) {
            return;
        }

        // Moving above the grid
        let currentY = this._adjustment.value;
        if (dragEvent.y <= gridY && currentY > 0) {
            this.goToPage(this._grid.currentPage - 1);
            return;
        }

        // Moving below the grid
        let maxY = this._adjustment.upper - this._adjustment.page_size;
        if (dragEvent.y >= gridBottom && currentY < maxY) {
            this.goToPage(this._grid.currentPage + 1);
        }
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this)
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(dragEvent) {
        if (!(dragEvent.source instanceof AppIcon))
            return DND.DragMotionResult.CONTINUE;

        let appIcon = dragEvent.source;

        // Handle the drag overshoot. When dragging to above the
        // icon grid, move to the page above; when dragging below,
        // move to the page below.
        if (this._grid.contains(appIcon.actor))
            this._handleDragOvershoot(dragEvent);

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
    }

    _canAccept(source) {
        if (!(source instanceof AppIcon))
            return false;

        let view = _getViewFromIcon(source);
        if (!(view instanceof FolderView))
            return false;

        return true;
    }

    handleDragOver(source) {
        if (!this._canAccept(source))
            return DND.DragMotionResult.NO_DROP;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!this._canAccept(source))
            return false;

        let view = _getViewFromIcon(source);
        view.removeApp(source.app);

        if (this._currentPopup)
            this._currentPopup.popdown();

        return true;
    }

    inhibitEventBlocker() {
        this._nEventBlockerInhibits++;
        this._eventBlocker.visible = this._nEventBlockerInhibits == 0;
    }

    uninhibitEventBlocker() {
        if (this._nEventBlockerInhibits === 0)
            throw new Error('Not inhibited');

        this._nEventBlockerInhibits--;
        this._eventBlocker.visible = this._nEventBlockerInhibits == 0;
    }

    createFolder(apps) {
        let newFolderId = GLib.uuid_string_random();

        let folders = this._folderSettings.get_strv('folder-children');
        folders.push(newFolderId);
        this._folderSettings.set_strv('folder-children', folders);

        // Create the new folder
        let newFolderPath = this._folderSettings.path.concat('folders/', newFolderId, '/');
        let newFolderSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.app-folders.folder',
            path: newFolderPath
        });
        if (!newFolderSettings) {
            log('Error creating new folder');
            return false;
        }

        let appItems = apps.map(id => this._items[id].app);
        let folderName = _findBestFolderName(appItems);
        if (!folderName)
            folderName = _("Unnamed Folder");

        newFolderSettings.delay();
        newFolderSettings.set_string('name', folderName);
        newFolderSettings.set_strv('apps', apps);
        newFolderSettings.apply();

        return true;
    }
};
Signals.addSignalMethods(AllView.prototype);

var FrequentView = class FrequentView extends BaseAppView {
    constructor() {
        super(null, { fillParent: true });

        this.actor = new St.Widget({ style_class: 'frequent-apps',
                                     layout_manager: new Clutter.BinLayout(),
                                     x_expand: true, y_expand: true });

        this._noFrequentAppsLabel = new St.Label({ text: _("Frequently used applications will appear here"),
                                                   style_class: 'no-frequent-applications-label',
                                                   x_align: Clutter.ActorAlign.CENTER,
                                                   x_expand: true,
                                                   y_align: Clutter.ActorAlign.CENTER,
                                                   y_expand: true });

        this._grid.y_expand = true;

        this.actor.add_actor(this._grid);
        this.actor.add_actor(this._noFrequentAppsLabel);
        this._noFrequentAppsLabel.hide();

        this._usage = Shell.AppUsage.get_default();

        this.actor.connect('notify::mapped', () => {
            if (this.actor.mapped)
                this._redisplay();
        });
    }

    hasUsefulData() {
        return this._usage.get_most_used().length >= MIN_FREQUENT_APPS_COUNT;
    }

    _compareItems() {
        // The FrequentView does not need to be sorted alphabetically
        return 0;
    }

    _loadApps() {
        let apps = [];
        let mostUsed = this._usage.get_most_used();
        let hasUsefulData = this.hasUsefulData();
        this._noFrequentAppsLabel.visible = !hasUsefulData;
        if (!hasUsefulData)
            return [];

        // Allow dragging of the icon only if the Dash would accept a drop to
        // change favorite-apps. There are no other possible drop targets from
        // the app picker, so there's no other need for a drag to start,
        // at least on single-monitor setups.
        // This also disables drag-to-launch on multi-monitor setups,
        // but we hope that is not used much.
        let favoritesWritable = global.settings.is_writable('favorite-apps');

        for (let i = 0; i < mostUsed.length; i++) {
            if (!mostUsed[i].get_app_info().should_show())
                continue;
            let appIcon = new AppIcon(mostUsed[i],
                                      { isDraggable: favoritesWritable });
            apps.push(appIcon);
        }

        return apps;
    }

    // Called before allocation to calculate dynamic spacing
    adaptToSize(width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this.actor.get_theme_node().get_content_box(box);
        box = this._grid.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        this._grid.adaptToSize(availWidth, availHeight);
    }
};

var Views = {
    FREQUENT: 0,
    ALL: 1
};

var ControlsBoxLayout = GObject.registerClass(
class ControlsBoxLayout extends Clutter.BoxLayout {
    /**
     * Override the BoxLayout behavior to use the maximum preferred width of all
     * buttons for each child
     */
    vfunc_get_preferred_width(container, forHeight) {
        let maxMinWidth = 0;
        let maxNaturalWidth = 0;
        for (let child = container.get_first_child();
            child;
            child = child.get_next_sibling()) {
            let [minWidth, natWidth] = child.get_preferred_width(forHeight);
            maxMinWidth = Math.max(maxMinWidth, minWidth);
            maxNaturalWidth = Math.max(maxNaturalWidth, natWidth);
        }
        let childrenCount = container.get_n_children();
        let totalSpacing = this.spacing * (childrenCount - 1);
        return [maxMinWidth * childrenCount + totalSpacing,
                maxNaturalWidth * childrenCount + totalSpacing];
    }
});

var ViewStackLayout = GObject.registerClass({
    Signals: { 'allocated-size-changed': { param_types: [GObject.TYPE_INT,
                                                         GObject.TYPE_INT] } },
}, class ViewStackLayout extends Clutter.BinLayout {
    vfunc_allocate(actor, box, flags) {
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        // Prepare children of all views for the upcoming allocation, calculate all
        // the needed values to adapt available size
        this.emit('allocated-size-changed', availWidth, availHeight);
        super.vfunc_allocate(actor, box, flags);
    }
});

var AppDisplay = class AppDisplay {
    constructor() {
        this._privacySettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.privacy' });
        this._privacySettings.connect('changed::remember-app-usage',
                                      this._updateFrequentVisibility.bind(this));

        this._views = [];

        let view, button;
        view = new FrequentView();
        button = new St.Button({ label: _("Frequent"),
                                 style_class: 'app-view-control button',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.FREQUENT] = { 'view': view, 'control': button };

        view = new AllView();
        button = new St.Button({ label: _("All"),
                                 style_class: 'app-view-control button',
                                 can_focus: true,
                                 x_expand: true });
        this._views[Views.ALL] = { 'view': view, 'control': button };

        this.actor = new St.BoxLayout ({ style_class: 'app-display',
                                         x_expand: true, y_expand: true,
                                         vertical: true });
        this._viewStackLayout = new ViewStackLayout();
        this._viewStack = new St.Widget({ x_expand: true, y_expand: true,
                                          layout_manager: this._viewStackLayout });
        this._viewStackLayout.connect('allocated-size-changed', this._onAllocatedSizeChanged.bind(this));
        this.actor.add_actor(this._viewStack);
        let layout = new ControlsBoxLayout({ homogeneous: true });
        this._controls = new St.Widget({ style_class: 'app-view-controls',
                                         layout_manager: layout });
        this._controls.connect('notify::mapped', () => {
            // controls are faded either with their parent or
            // explicitly in animate(); we can't know how they'll be
            // shown next, so make sure to restore their opacity
            // when they are hidden
            if (this._controls.mapped)
                return;

            this._controls.remove_all_transitions();
            this._controls.opacity = 255;
        });

        layout.hookup_style(this._controls);
        this.actor.add_actor(new St.Bin({ child: this._controls }));

        for (let i = 0; i < this._views.length; i++) {
            this._viewStack.add_actor(this._views[i].view.actor);
            this._controls.add_actor(this._views[i].control);

            let viewIndex = i;
            this._views[i].control.connect('clicked', () => {
                this._showView(viewIndex);
                global.settings.set_uint('app-picker-view', viewIndex);
            });
        }
        let initialView = Math.min(global.settings.get_uint('app-picker-view'),
                                   this._views.length - 1);
        let frequentUseful = this._views[Views.FREQUENT].view.hasUsefulData();
        if (initialView == Views.FREQUENT && !frequentUseful)
            initialView = Views.ALL;
        this._showView(initialView);
        this._updateFrequentVisibility();

        Gio.DBus.system.watch_name(SWITCHEROO_BUS_NAME,
                                   Gio.BusNameWatcherFlags.NONE,
                                   this._switcherooProxyAppeared.bind(this),
                                   () => {
                                       this._switcherooProxy = null;
                                       this._updateDiscreteGpuAvailable();
                                   });
    }

    _updateDiscreteGpuAvailable() {
        if (!this._switcherooProxy)
            discreteGpuAvailable = false;
        else
            discreteGpuAvailable = this._switcherooProxy.HasDualGpu;
    }

    _switcherooProxyAppeared() {
        this._switcherooProxy = new SwitcherooProxy(Gio.DBus.system, SWITCHEROO_BUS_NAME, SWITCHEROO_OBJECT_PATH,
            (proxy, error) => {
                if (error) {
                    log(error.message);
                    return;
                }
                this._updateDiscreteGpuAvailable();
            });
    }

    animate(animationDirection, onComplete) {
        let currentView = this._views.filter(v => v.control.has_style_pseudo_class('checked')).pop().view;

        // Animate controls opacity using iconGrid animation time, since
        // it will be the time the AllView or FrequentView takes to show
        // it entirely.
        let finalOpacity;
        if (animationDirection == IconGrid.AnimationDirection.IN) {
            this._controls.opacity = 0;
            finalOpacity = 255;
        } else {
            finalOpacity = 0;
        }

        this._controls.ease({
            opacity: finalOpacity,
            duration: IconGrid.ANIMATION_TIME_IN,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD
        });

        currentView.animate(animationDirection, onComplete);
    }

    _showView(activeIndex) {
        for (let i = 0; i < this._views.length; i++) {
            if (i == activeIndex)
                this._views[i].control.add_style_pseudo_class('checked');
            else
                this._views[i].control.remove_style_pseudo_class('checked');

            let animationDirection = i == activeIndex
                ? IconGrid.AnimationDirection.IN
                : IconGrid.AnimationDirection.OUT;
            this._views[i].view.animateSwitch(animationDirection);
        }
    }

    _updateFrequentVisibility() {
        let enabled = this._privacySettings.get_boolean('remember-app-usage');
        this._views[Views.FREQUENT].control.visible = enabled;

        let visibleViews = this._views.filter(v => v.control.visible);
        this._controls.visible = visibleViews.length > 1;

        if (!enabled && this._views[Views.FREQUENT].view.actor.visible)
            this._showView(Views.ALL);
    }

    selectApp(id) {
        this._showView(Views.ALL);
        this._views[Views.ALL].view.selectApp(id);
    }

    _onAllocatedSizeChanged(actor, width, height) {
        let box = new Clutter.ActorBox();
        box.x1 = box.y1 = 0;
        box.x2 = width;
        box.y2 = height;
        box = this._viewStack.get_theme_node().get_content_box(box);
        let availWidth = box.x2 - box.x1;
        let availHeight = box.y2 - box.y1;
        for (let i = 0; i < this._views.length; i++)
            this._views[i].view.adaptToSize(availWidth, availHeight);
    }
};

var AppSearchProvider = class AppSearchProvider {
    constructor() {
        this._appSys = Shell.AppSystem.get_default();
        this.id = 'applications';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;

        this._systemActions = new SystemActions.getDefault();
    }

    getResultMetas(apps, callback) {
        let metas = [];
        for (let id of apps) {
            if (id.endsWith('.desktop')) {
                let app = this._appSys.lookup_app(id);

                metas.push({
                    id: app.get_id(),
                    name: app.get_name(),
                    createIcon: size => app.create_icon_texture(size),
                });
            } else {
                let name = this._systemActions.getName(id);
                let iconName = this._systemActions.getIconName(id);

                let createIcon = size => new St.Icon({ icon_name: iconName,
                                                       width: size,
                                                       height: size,
                                                       style_class: 'system-action-icon' });

                metas.push({ id, name, createIcon });
            }
        }

        callback(metas);
    }

    filterResults(results, maxNumber) {
        return results.slice(0, maxNumber);
    }

    getInitialResultSet(terms, callback, _cancellable) {
        let query = terms.join(' ');
        let groups = Shell.AppSystem.search(query);
        let usage = Shell.AppUsage.get_default();
        let results = [];
        groups.forEach(group => {
            group = group.filter(appID => {
                let app = Gio.DesktopAppInfo.new(appID);
                return app && app.should_show();
            });
            results = results.concat(group.sort(
                (a, b) => usage.compare(a, b)
            ));
        });

        results = results.concat(this._systemActions.getMatchingActions(terms));

        callback(results);
    }

    getSubsearchResultSet(previousResults, terms, callback, cancellable) {
        this.getInitialResultSet(terms, callback, cancellable);
    }

    createResultObject(resultMeta) {
        if (resultMeta.id.endsWith('.desktop'))
            return new AppIcon(this._appSys.lookup_app(resultMeta['id']));
        else
            return new SystemActionIcon(this, resultMeta);
    }
};

var FolderView = class FolderView extends BaseAppView {
    constructor(folder, id, parentView) {
        super(null, null);
        // If it not expand, the parent doesn't take into account its preferred_width when allocating
        // the second time it allocates, so we apply the "Standard hack for ClutterBinLayout"
        this._grid.x_expand = true;
        this._id = id;
        this._folder = folder;
        this._parentView = parentView;
        this._grid._delegate = this;

        this.actor = new St.ScrollView({ overlay_scrollbars: true });
        this.actor.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        let scrollableContainer = new St.BoxLayout({ vertical: true, reactive: true });
        scrollableContainer.add_actor(this._grid);
        this.actor.add_actor(scrollableContainer);

        let action = new Clutter.PanAction({ interpolate: true });
        action.connect('pan', this._onPan.bind(this));
        this.actor.add_action(action);

        this._folder.connect('changed', this._redisplay.bind(this));
        this._redisplay();
    }

    _childFocused(actor) {
        Util.ensureActorVisibleInScrollView(this.actor, actor);
    }

    // Overridden from BaseAppView
    animate(animationDirection) {
        this._grid.animatePulse(animationDirection);
    }

    createFolderIcon(size) {
        let layout = new Clutter.GridLayout();
        let icon = new St.Widget({ layout_manager: layout,
                                   style_class: 'app-folder-icon' });
        layout.hookup_style(icon);
        let subSize = Math.floor(FOLDER_SUBICON_FRACTION * size);
        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        let numItems = this._allItems.length;
        let rtl = icon.get_text_direction() == Clutter.TextDirection.RTL;
        for (let i = 0; i < 4; i++) {
            let bin = new St.Bin({ width: subSize * scale, height: subSize * scale });
            if (i < numItems)
                bin.child = this._allItems[i].app.create_icon_texture(subSize);
            layout.attach(bin, rtl ? (i + 1) % 2 : i % 2, Math.floor(i / 2), 1, 1);
        }

        return icon;
    }

    _onPan(action) {
        let [dist_, dx_, dy] = action.get_motion_delta(0);
        let adjustment = this.actor.vscroll.adjustment;
        adjustment.value -= (dy / this.actor.height) * adjustment.page_size;
        return false;
    }

    adaptToSize(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;

        this._grid.adaptToSize(width, height);

        // To avoid the fade effect being applied to the unscrolled grid,
        // the offset would need to be applied after adjusting the padding;
        // however the final padding is expected to be too small for the
        // effect to look good, so use the unadjusted padding
        let fadeOffset = Math.min(this._grid.topPadding,
                                  this._grid.bottomPadding);
        this.actor.update_fade_effect(fadeOffset, 0);

        // Set extra padding to avoid popup or close button being cut off
        this._grid.topPadding = Math.max(this._grid.topPadding - this._offsetForEachSide, 0);
        this._grid.bottomPadding = Math.max(this._grid.bottomPadding - this._offsetForEachSide, 0);
        this._grid.leftPadding = Math.max(this._grid.leftPadding - this._offsetForEachSide, 0);
        this._grid.rightPadding = Math.max(this._grid.rightPadding - this._offsetForEachSide, 0);

        this.actor.set_width(this.usedWidth());
        this.actor.set_height(this.usedHeight());
    }

    _getPageAvailableSize() {
        let pageBox = new Clutter.ActorBox();
        pageBox.x1 = pageBox.y1 = 0;
        pageBox.x2 = this._parentAvailableWidth;
        pageBox.y2 = this._parentAvailableHeight;

        let contentBox = this.actor.get_theme_node().get_content_box(pageBox);
        // We only can show icons inside the collection view boxPointer
        // so we have to subtract the required padding etc of the boxpointer
        return [(contentBox.x2 - contentBox.x1) - 2 * this._offsetForEachSide, (contentBox.y2 - contentBox.y1) - 2 * this._offsetForEachSide];
    }

    usedWidth() {
        let [availWidthPerPage] = this._getPageAvailableSize();
        return this._grid.usedWidth(availWidthPerPage);
    }

    usedHeight() {
        return this._grid.usedHeightForNRows(this.nRowsDisplayedAtOnce());
    }

    nRowsDisplayedAtOnce() {
        let [availWidthPerPage, availHeightPerPage] = this._getPageAvailableSize();
        let maxRows = this._grid.rowsForHeight(availHeightPerPage) - 1;
        return Math.min(this._grid.nRows(availWidthPerPage), maxRows);
    }

    setPaddingOffsets(offset) {
        this._offsetForEachSide = offset;
    }

    _loadApps() {
        let apps = [];
        let excludedApps = this._folder.get_strv('excluded-apps');
        let appSys = Shell.AppSystem.get_default();
        let addAppId = appId => {
            if (excludedApps.includes(appId))
                return;

            let app = appSys.lookup_app(appId);
            if (!app)
                return;

            if (!app.get_app_info().should_show())
                return;

            if (apps.some(appIcon => appIcon.id == appId))
                return;

            let icon = new AppIcon(app);
            apps.push(icon);
        };

        let folderApps = this._folder.get_strv('apps');
        folderApps.forEach(addAppId);

        let folderCategories = this._folder.get_strv('categories');
        let appInfos = this._parentView.getAppInfos();
        appInfos.forEach(appInfo => {
            let appCategories = _getCategories(appInfo);
            if (!_listsIntersect(folderCategories, appCategories))
                return;

            addAppId(appInfo.get_id());
        });

        return apps;
    }

    removeApp(app) {
        let folderApps = this._folder.get_strv('apps');
        let index = folderApps.indexOf(app.id);
        if (index >= 0)
            folderApps.splice(index, 1);

        // If this is a categories-based folder, also add it to
        // the list of excluded apps
        let categories = this._folder.get_strv('categories');
        if (categories.length > 0) {
            let excludedApps = this._folder.get_strv('excluded-apps');
            excludedApps.push(app.id);
            this._folder.set_strv('excluded-apps', excludedApps);
        }

        // Remove the folder if this is the last app icon; otherwise,
        // just remove the icon
        if (folderApps.length == 0) {
            let settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
            let folders = settings.get_strv('folder-children');
            folders.splice(folders.indexOf(this._id), 1);
            settings.set_strv('folder-children', folders);

            // Resetting all keys deletes the relocatable schema
            let keys = this._folder.settings_schema.list_keys();
            for (let key of keys)
                this._folder.reset(key);
        } else {
            this._folder.set_strv('apps', folderApps);
        }

        return true;
    }
};

var FolderIcon = class FolderIcon {
    constructor(id, path, parentView) {
        this.id = id;
        this.name = '';
        this._parentView = parentView;

        this._folder = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders.folder',
                                          path: path });
        this.actor = new St.Button({ style_class: 'app-well-app app-folder',
                                     button_mask: St.ButtonMask.ONE,
                                     toggle_mode: true,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });
        this.actor._delegate = this;
        // whether we need to update arrow side, position etc.
        this._popupInvalidated = false;

        this.icon = new IconGrid.BaseIcon('', {
            createIcon: this._createIcon.bind(this),
            setSizeManually: true
        });
        this.actor.set_child(this.icon);
        this.actor.label_actor = this.icon.label;

        this.view = new FolderView(this._folder, id, parentView);

        this._itemDragBeginId = Main.overview.connect(
            'item-drag-begin', this._onDragBegin.bind(this));
        this._itemDragEndId = Main.overview.connect(
            'item-drag-end', this._onDragEnd.bind(this));

        this._popupTimeoutId = 0;

        this.actor.connect('leave-event', this._onLeaveEvent.bind(this));
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));
        this.actor.connect('touch-event', this._onTouchEvent.bind(this));
        this.actor.connect('popup-menu', this._popupRenamePopup.bind(this));

        this.actor.connect('clicked', this.open.bind(this));
        this.actor.connect('destroy', this.onDestroy.bind(this));
        this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped && this._popup)
                this._popup.popdown();
        });

        this._folder.connect('changed', this._redisplay.bind(this));
        this._redisplay();
    }

    onDestroy() {
        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);

        this.view.actor.destroy();

        if (this._spaceReadySignalId) {
            this._parentView.disconnect(this._spaceReadySignalId);
            this._spaceReadySignalId = 0;
        }

        if (this._popup)
            this._popup.actor.destroy();

        this._removeMenuTimeout();
    }

    open() {
        this._removeMenuTimeout();
        this._ensurePopup();
        this.view.actor.vscroll.adjustment.value = 0;
        this._openSpaceForPopup();
    }

    getAppIds() {
        return this.view.getAllItems().map(item => item.id);
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);

        this._parentView.inhibitEventBlocker();
    }

    _onDragMotion(dragEvent) {
        let target = dragEvent.targetActor;

        if (!this.actor.contains(target) || !this._canAccept(dragEvent.source))
            this.actor.remove_style_pseudo_class('drop');
        else
            this.actor.add_style_pseudo_class('drop');

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        this.actor.remove_style_pseudo_class('drop');
        this._parentView.uninhibitEventBlocker();
        DND.removeDragMonitor(this._dragMonitor);
    }

    _canAccept(source) {
        if (!(source instanceof AppIcon))
            return false;

        let view = _getViewFromIcon(source);
        if (!view || !(view instanceof AllView))
            return false;

        if (this._folder.get_strv('apps').includes(source.id))
            return false;

        return true;
    }

    handleDragOver(source) {
        if (!this._canAccept(source))
            return DND.DragMotionResult.NO_DROP;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!this._canAccept(source))
            return false;

        let app = source.app;
        let folderApps = this._folder.get_strv('apps');
        folderApps.push(app.id);

        this._folder.set_strv('apps', folderApps);

        // Also remove from 'excluded-apps' if the app id is listed
        // there. This is only possible on categories-based folders.
        let excludedApps = this._folder.get_strv('excluded-apps');
        let index = excludedApps.indexOf(app.id);
        if (index >= 0) {
            excludedApps.splice(index, 1);
            this._folder.set_strv('excluded-apps', excludedApps);
        }

        return true;
    }

    _updateName() {
        let name = _getFolderName(this._folder);
        if (this.name == name)
            return;

        this.name = name;
        this.icon.label.text = this.name;
        this.emit('name-changed');
    }

    _redisplay() {
        this._updateName();
        this.actor.visible = this.view.getAllItems().length > 0;
        this.icon.update();
        this.emit('apps-changed');
    }

    _createIcon(iconSize) {
        return this.view.createFolderIcon(iconSize, this);
    }

    _popupHeight() {
        let usedHeight = this.view.usedHeight() + this._popup.getOffset(St.Side.TOP) + this._popup.getOffset(St.Side.BOTTOM);
        return usedHeight;
    }

    _openSpaceForPopup() {
        this._spaceReadySignalId = this._parentView.connect('space-ready', () => {
            this._parentView.disconnect(this._spaceReadySignalId);
            this._spaceReadySignalId = 0;
            this._popup.popup();
            this._updatePopupPosition();
        });
        this._parentView.openSpaceForPopup(this, this._boxPointerArrowside, this.view.nRowsDisplayedAtOnce());
    }

    _calculateBoxPointerArrowSide() {
        let spaceTop = this.actor.y - this._parentView.getCurrentPageY();
        let spaceBottom = this._parentView.actor.height - (spaceTop + this.actor.height);

        return spaceTop > spaceBottom ? St.Side.BOTTOM : St.Side.TOP;
    }

    _updatePopupSize() {
        // StWidget delays style calculation until needed, make sure we use the correct values
        this.view._grid.ensure_style();

        let offsetForEachSide = Math.ceil((this._popup.getOffset(St.Side.TOP) +
                                           this._popup.getOffset(St.Side.BOTTOM) -
                                           this._popup.getCloseButtonOverlap()) / 2);
        // Add extra padding to prevent boxpointer decorations and close button being cut off
        this.view.setPaddingOffsets(offsetForEachSide);
        this.view.adaptToSize(this._parentAvailableWidth, this._parentAvailableHeight);
    }

    _updatePopupPosition() {
        if (!this._popup)
            return;

        if (this._boxPointerArrowside == St.Side.BOTTOM)
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y - this._popupHeight();
        else
            this._popup.actor.y = this.actor.allocation.y1 + this.actor.translation_y + this.actor.height;
    }

    _ensurePopup() {
        if (this._popup && !this._popupInvalidated)
            return;
        this._boxPointerArrowside = this._calculateBoxPointerArrowSide();
        if (!this._popup) {
            this._popup = new AppFolderPopup(this, this._boxPointerArrowside);
            this._parentView.addFolderPopup(this._popup);
            this._popup.connect('open-state-changed', (popup, isOpen) => {
                if (!isOpen)
                    this.actor.checked = false;
            });
        } else {
            this._popup.updateArrowSide(this._boxPointerArrowside);
        }
        this._updatePopupSize();
        this._updatePopupPosition();
        this._popupInvalidated = false;
    }

    _removeMenuTimeout() {
        if (this._popupTimeoutId > 0) {
            GLib.source_remove(this._popupTimeoutId);
            this._popupTimeoutId = 0;
        }
    }

    _setPopupTimeout() {
        this._removeMenuTimeout();
        this._popupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_POPUP_TIMEOUT, () => {
            this._popupTimeoutId = 0;
            this._popupRenamePopup();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._popupTimeoutId,
                                   '[gnome-shell] this._popupRenamePopup');
    }

    _onLeaveEvent(_actor, _event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    }

    _onButtonPress(_actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._setPopupTimeout();
        } else if (button == 3) {
            this._popupRenamePopup();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTouchEvent(actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN)
            this._setPopupTimeout();

        return Clutter.EVENT_PROPAGATE;
    }

    _popupRenamePopup() {
        this._removeMenuTimeout();
        this.actor.fake_release();

        if (!this._menu) {
            this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

            this._menu = new RenameFolderMenu(this, this._folder);
            this._menuManager.addMenu(this._menu);

            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this.actor.sync_hover();
            });
            let id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });
        }

        this.actor.set_hover(true);
        this._menu.open();
        this._menuManager.ignoreRelease();
    }

    adaptToSize(width, height) {
        this._parentAvailableWidth = width;
        this._parentAvailableHeight = height;
        if (this._popup)
            this.view.adaptToSize(width, height);
        this._popupInvalidated = true;
    }
};
Signals.addSignalMethods(FolderIcon.prototype);

var RenameFolderMenuItem = GObject.registerClass(
class RenameFolderMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(folder) {
        super._init({
            style_class: 'rename-folder-popup-item',
            reactive: false,
        });
        this.setOrnament(PopupMenu.Ornament.HIDDEN);

        this._folder = folder;

        // Entry
        this._entry = new St.Entry({
            x_expand: true,
            width: 200,
        });
        this.add_child(this._entry);

        this._entry.clutter_text.connect(
            'notify::text', this._validate.bind(this));
        this._entry.clutter_text.connect(
            'activate', this._updateFolderName.bind(this));

        // Rename button
        this._button = new St.Button({
            style_class: 'button',
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            can_focus: true,
            label: _('Rename'),
        });
        this.add_child(this._button);

        this._button.connect('clicked', this._updateFolderName.bind(this));
    }

    vfunc_map() {
        this._entry.text = _getFolderName(this._folder);
        this._entry.clutter_text.set_selection(0, -1);
        super.vfunc_map();
    }

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        this._entry.clutter_text.grab_key_focus();
    }

    _isValidFolderName() {
        let folderName = _getFolderName(this._folder);
        let newFolderName = this._entry.text.trim();

        return newFolderName.length > 0 && newFolderName != folderName;
    }

    _validate() {
        let isValid = this._isValidFolderName();

        this._button.reactive = isValid;
    }

    _updateFolderName() {
        if (!this._isValidFolderName())
            return;

        let newFolderName = this._entry.text.trim();
        this._folder.set_string('name', newFolderName);
        this._folder.set_boolean('translate', false);
        this.activate(Clutter.get_current_event());
    }
});

var RenameFolderMenu = class RenameFolderMenu extends PopupMenu.PopupMenu {
    constructor(source, folder) {
        super(source.actor, 0.5, St.Side.BOTTOM);
        this.actor.add_style_class_name('rename-folder-popup');

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        let menuItem = new RenameFolderMenuItem(folder);
        this.addMenuItem(menuItem);

        // Focus the text entry on menu pop-up
        this.focusActor = menuItem;

        // Chain our visibility and lifecycle to that of the source
        this._sourceMappedId = source.actor.connect('notify::mapped', () => {
            if (!source.actor.mapped)
                this.close();
        });
        source.actor.connect('destroy', () => {
            source.actor.disconnect(this._sourceMappedId);
            this.destroy();
        });

        Main.uiGroup.add_actor(this.actor);
    }
};
Signals.addSignalMethods(RenameFolderMenu.prototype);

var AppFolderPopup = class AppFolderPopup {
    constructor(source, side) {
        this._source = source;
        this._view = source.view;
        this._arrowSide = side;

        this._isOpen = false;
        this.parentOffset = 0;

        this.actor = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                     visible: false,
                                     // We don't want to expand really, but look
                                     // at the layout manager of our parent...
                                     //
                                     // DOUBLE HACK: if you set one, you automatically
                                     // get the effect for the other direction too, so
                                     // we need to set the y_align
                                     x_expand: true,
                                     y_expand: true,
                                     x_align: Clutter.ActorAlign.CENTER,
                                     y_align: Clutter.ActorAlign.START });
        this._boxPointer = new BoxPointer.BoxPointer(this._arrowSide,
                                                     { style_class: 'app-folder-popup-bin',
                                                       x_fill: true,
                                                       y_fill: true,
                                                       x_expand: true,
                                                       x_align: St.Align.START });

        this._boxPointer.style_class = 'app-folder-popup';
        this.actor.add_actor(this._boxPointer);
        this._boxPointer.bin.set_child(this._view.actor);

        this.closeButton = Util.makeCloseButton(this._boxPointer);
        this.closeButton.connect('clicked', this.popdown.bind(this));
        this.actor.add_actor(this.closeButton);

        this._boxPointer.bind_property('opacity', this.closeButton, 'opacity',
                                       GObject.BindingFlags.SYNC_CREATE);

        global.focus_manager.add_group(this.actor);

        this._grabHelper = new GrabHelper.GrabHelper(this.actor, {
            actionMode: Shell.ActionMode.POPUP
        });
        this._grabHelper.addActor(Main.layoutManager.overviewGroup);
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
        this.actor.connect('destroy', this._onDestroy.bind(this));
    }

    _onDestroy() {
        if (this._isOpen) {
            this._isOpen = false;
            this._grabHelper.ungrab({ actor: this.actor });
            this._grabHelper = null;
        }
    }

    _onKeyPress(actor, event) {
        if (global.stage.get_key_focus() != actor)
            return Clutter.EVENT_PROPAGATE;

        // Since we need to only grab focus on one item child when the user
        // actually press a key we don't use navigate_focus when opening
        // the popup.
        // Instead of that, grab the focus on the AppFolderPopup actor
        // and actually moves the focus to a child only when the user
        // actually press a key.
        // It should work with just grab_key_focus on the AppFolderPopup
        // actor, but since the arrow keys are not wrapping_around the focus
        // is not grabbed by a child when the widget that has the current focus
        // is the same that is requesting focus, so to make it works with arrow
        // keys we need to connect to the key-press-event and navigate_focus
        // when that happens using TAB_FORWARD or TAB_BACKWARD instead of arrow
        // keys

        // Use TAB_FORWARD for down key and right key
        // and TAB_BACKWARD for up key and left key on ltr
        // languages
        let direction;
        let isLtr = Clutter.get_default_text_direction() == Clutter.TextDirection.LTR;
        switch (event.get_key_symbol()) {
        case Clutter.Down:
            direction = St.DirectionType.TAB_FORWARD;
            break;
        case Clutter.Right:
            direction = isLtr
                ? St.DirectionType.TAB_FORWARD
                : St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.Up:
            direction = St.DirectionType.TAB_BACKWARD;
            break;
        case Clutter.Left:
            direction = isLtr
                ? St.DirectionType.TAB_BACKWARD
                : St.DirectionType.TAB_FORWARD;
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        return actor.navigate_focus(null, direction, false);
    }

    toggle() {
        if (this._isOpen)
            this.popdown();
        else
            this.popup();
    }

    popup() {
        if (this._isOpen)
            return;

        this._isOpen = this._grabHelper.grab({ actor: this.actor,
                                               onUngrab: this.popdown.bind(this) });

        if (!this._isOpen)
            return;

        this.actor.show();

        this._boxPointer.setArrowActor(this._source.actor);
        // We need to hide the icons of the view until the boxpointer animation
        // is completed so we can animate the icons after as we like without
        // showing them while boxpointer is animating.
        this._view.actor.opacity = 0;
        this._boxPointer.open(BoxPointer.PopupAnimation.FADE |
                              BoxPointer.PopupAnimation.SLIDE,
                              () => {
                                  this._view.actor.opacity = 255;
                                  this._view.animate(IconGrid.AnimationDirection.IN);
                              });

        this.emit('open-state-changed', true);
    }

    popdown() {
        if (!this._isOpen)
            return;

        this._grabHelper.ungrab({ actor: this.actor });

        this._boxPointer.close(BoxPointer.PopupAnimation.FADE |
                               BoxPointer.PopupAnimation.SLIDE);
        this._isOpen = false;
        this.emit('open-state-changed', false);
    }

    getCloseButtonOverlap() {
        return this.closeButton.get_theme_node().get_length('-shell-close-overlap-y');
    }

    getOffset(side) {
        let offset = this._boxPointer.getPadding(side);
        if (this._arrowSide == side)
            offset += this._boxPointer.getArrowHeight();
        return offset;
    }

    updateArrowSide(side) {
        this._arrowSide = side;
        this._boxPointer.updateArrowSide(side);
    }
};
Signals.addSignalMethods(AppFolderPopup.prototype);

var AppIcon = class AppIcon {
    constructor(app, iconParams = {}) {
        this.app = app;
        this.id = app.get_id();
        this.name = app.get_name();

        this.actor = new St.Button({ style_class: 'app-well-app',
                                     pivot_point: new Clutter.Point({ x: 0.5, y: 0.5 }),
                                     reactive: true,
                                     button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
                                     can_focus: true,
                                     x_fill: true,
                                     y_fill: true });

        this._dot = new St.Widget({ style_class: 'app-well-app-running-dot',
                                    layout_manager: new Clutter.BinLayout(),
                                    x_expand: true, y_expand: true,
                                    x_align: Clutter.ActorAlign.CENTER,
                                    y_align: Clutter.ActorAlign.END });

        this._iconContainer = new St.Widget({ layout_manager: new Clutter.BinLayout(),
                                              x_expand: true, y_expand: true });

        this.actor.set_child(this._iconContainer);
        this._iconContainer.add_child(this._dot);

        this.actor._delegate = this;

        this._hasDndHover = false;
        this._folderPreviewId = 0;

        // Get the isDraggable property without passing it on to the BaseIcon:
        let appIconParams = Params.parse(iconParams, { isDraggable: true }, true);
        let isDraggable = appIconParams['isDraggable'];
        delete iconParams['isDraggable'];

        iconParams['createIcon'] = this._createIcon.bind(this);
        iconParams['setSizeManually'] = true;
        this.icon = new IconGrid.BaseIcon(app.get_name(), iconParams);
        this._iconContainer.add_child(this.icon);

        this.actor.label_actor = this.icon.label;

        this.actor.connect('leave-event', this._onLeaveEvent.bind(this));
        this.actor.connect('button-press-event', this._onButtonPress.bind(this));
        this.actor.connect('touch-event', this._onTouchEvent.bind(this));
        this.actor.connect('clicked', this._onClicked.bind(this));
        this.actor.connect('popup-menu', this._onKeyboardPopupMenu.bind(this));

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this.actor);

        if (isDraggable) {
            this._draggable = DND.makeDraggable(this.actor);
            this._draggable.connect('drag-begin', () => {
                this._dragging = true;
                this.scaleAndFade();
                this._removeMenuTimeout();
                Main.overview.beginItemDrag(this);
            });
            this._draggable.connect('drag-cancelled', () => {
                this._dragging = false;
                Main.overview.cancelledItemDrag(this);
            });
            this._draggable.connect('drag-end', () => {
                this._dragging = false;
                this.undoScaleAndFade();
                Main.overview.endItemDrag(this);
            });
        }

        this._itemDragBeginId = Main.overview.connect(
            'item-drag-begin', this._onDragBegin.bind(this));
        this._itemDragEndId = Main.overview.connect(
            'item-drag-end', this._onDragEnd.bind(this));

        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._menuTimeoutId = 0;
        this._stateChangedId = this.app.connect('notify::state', () => {
            this._updateRunningStyle();
        });
        this._updateRunningStyle();
    }

    _onDestroy() {
        Main.overview.disconnect(this._itemDragBeginId);
        Main.overview.disconnect(this._itemDragEndId);

        if (this._folderPreviewId > 0) {
            GLib.source_remove(this._folderPreviewId);
            this._folderPreviewId = 0;
        }
        if (this._stateChangedId > 0)
            this.app.disconnect(this._stateChangedId);
        if (this._draggable) {
            if (this._dragging)
                Main.overview.endItemDrag(this);
            this._draggable = null;
        }
        this._stateChangedId = 0;
        this._removeMenuTimeout();
    }

    _createIcon(iconSize) {
        return this.app.create_icon_texture(iconSize);
    }

    _removeMenuTimeout() {
        if (this._menuTimeoutId > 0) {
            GLib.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    }

    _updateRunningStyle() {
        if (this.app.state != Shell.AppState.STOPPED)
            this._dot.show();
        else
            this._dot.hide();
    }

    _setPopupTimeout() {
        this._removeMenuTimeout();
        this._menuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MENU_POPUP_TIMEOUT, () => {
            this._menuTimeoutId = 0;
            this.popupMenu();
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._menuTimeoutId, '[gnome-shell] this.popupMenu');
    }

    _onLeaveEvent(_actor, _event) {
        this.actor.fake_release();
        this._removeMenuTimeout();
    }

    _onButtonPress(_actor, event) {
        let button = event.get_button();
        if (button == 1) {
            this._setPopupTimeout();
        } else if (button == 3) {
            this.popupMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTouchEvent(actor, event) {
        if (event.type() == Clutter.EventType.TOUCH_BEGIN)
            this._setPopupTimeout();

        return Clutter.EVENT_PROPAGATE;
    }

    _onClicked(actor, button) {
        this._removeMenuTimeout();
        this.activate(button);
    }

    _onKeyboardPopupMenu() {
        this.popupMenu();
        this._menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    getId() {
        return this.app.get_id();
    }

    popupMenu() {
        this._removeMenuTimeout();
        this.actor.fake_release();

        if (this._draggable)
            this._draggable.fakeRelease();

        if (!this._menu) {
            this._menu = new AppIconMenu(this);
            this._menu.connect('activate-window', (menu, window) => {
                this.activateWindow(window);
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            let id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.actor.set_hover(true);
        this._menu.popup();
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');

        return false;
    }

    activateWindow(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    }

    _onMenuPoppedDown() {
        this.actor.sync_hover();
        this.emit('menu-state-changed', false);
    }

    activate(button) {
        let event = Clutter.get_current_event();
        let modifiers = event ? event.get_state() : 0;
        let isMiddleButton = button && button == Clutter.BUTTON_MIDDLE;
        let isCtrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK) != 0;
        let openNewWindow = this.app.can_open_new_window() &&
                            this.app.state == Shell.AppState.RUNNING &&
                            (isCtrlPressed || isMiddleButton);

        if (this.app.state == Shell.AppState.STOPPED || openNewWindow)
            this.animateLaunch();

        if (openNewWindow)
            this.app.open_new_window(-1);
        else
            this.app.activate();

        Main.overview.hide();
    }

    animateLaunch() {
        this.icon.animateZoomOut();
    }

    animateLaunchAtPos(x, y) {
        this.icon.animateZoomOutAtPos(x, y);
    }

    scaleIn() {
        this.actor.scale_x = 0;
        this.actor.scale_y = 0;

        this.actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: APP_ICON_SCALE_IN_TIME,
            delay: APP_ICON_SCALE_IN_DELAY,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT
        });
    }

    shellWorkspaceLaunch(params) {
        let { stack } = new Error();
        log(`shellWorkspaceLaunch is deprecated, use app.open_new_window() instead\n${stack}`);

        params = Params.parse(params, { workspace: -1,
                                        timestamp: 0 });

        this.app.open_new_window(params.workspace);
    }

    getDragActor() {
        return this.app.create_icon_texture(Main.overview.dashIconSize);
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this.icon.icon;
    }

    shouldShowTooltip() {
        return this.actor.hover && (!this._menu || !this._menu.isOpen);
    }

    scaleAndFade() {
        this.actor.reactive = false;
        this.actor.ease({
            scale_x: 0.75,
            scale_y: 0.75,
            opacity: 128
        });
    }

    undoScaleAndFade() {
        this.actor.reactive = true;
        this.actor.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255
        });
    }

    _showFolderPreview() {
        this.icon.label.opacity = 0;
        this.icon.icon.ease({
            scale_x: FOLDER_SUBICON_FRACTION,
            scale_y: FOLDER_SUBICON_FRACTION
        });
    }

    _hideFolderPreview() {
        this.icon.label.opacity = 255;
        this.icon.icon.ease({
            scale_x: 1.0,
            scale_y: 1.0
        });
    }

    _canAccept(source) {
        let view = _getViewFromIcon(source);

        return source != this &&
               (source instanceof AppIcon) &&
               (view instanceof AllView);
    }

    _setHoveringByDnd(hovering) {
        if (hovering) {
            if (this._folderPreviewId > 0)
                return;

            this._folderPreviewId =
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    this.actor.add_style_pseudo_class('drop');
                    this._showFolderPreview();
                    this._folderPreviewId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            if (this._folderPreviewId > 0) {
                GLib.source_remove(this._folderPreviewId);
                this._folderPreviewId = 0;
            }
            this._hideFolderPreview();
            this.actor.remove_style_pseudo_class('drop');
        }
    }

    _onDragBegin() {
        this._dragMonitor = {
            dragMotion: this._onDragMotion.bind(this),
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _onDragMotion(dragEvent) {
        let target = dragEvent.targetActor;
        let isHovering = target == this.actor || this.actor.contains(target);
        let canDrop = this._canAccept(dragEvent.source);
        let hasDndHover = isHovering && canDrop;

        if (this._hasDndHover != hasDndHover) {
            this._setHoveringByDnd(hasDndHover);
            this._hasDndHover = hasDndHover;
        }

        return DND.DragMotionResult.CONTINUE;
    }

    _onDragEnd() {
        this.actor.remove_style_pseudo_class('drop');
        DND.removeDragMonitor(this._dragMonitor);
    }

    handleDragOver(source) {
        if (source == this)
            return DND.DragMotionResult.NO_DROP;

        if (!this._canAccept(source))
            return DND.DragMotionResult.CONTINUE;

        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        this._setHoveringByDnd(false);

        if (!this._canAccept(source))
            return false;

        let view = _getViewFromIcon(this);
        let apps = [this.id, source.id];

        return view.createFolder(apps);
    }
};
Signals.addSignalMethods(AppIcon.prototype);

var AppIconMenu = class AppIconMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        let side = St.Side.LEFT;
        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL)
            side = St.Side.RIGHT;

        super(source.actor, 0.5, side);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        this._sourceMappedId = source.actor.connect('notify::mapped', () => {
            if (!source.actor.mapped)
                this.close();
        });
        source.actor.connect('destroy', () => {
            source.actor.disconnect(this._sourceMappedId);
            this.destroy();
        });

        Main.uiGroup.add_actor(this.actor);
    }

    _redisplay() {
        this.removeAll();

        let windows = this._source.app.get_windows().filter(
            w => !w.skip_taskbar
        );

        if (windows.length > 0)
            this.addMenuItem(
                /* Translators: This is the heading of a list of open windows */
                new PopupMenu.PopupSeparatorMenuItem(_("Open Windows"))
            );

        windows.forEach(window => {
            let title = window.title
                ? window.title : this._source.app.get_name();
            let item = this._appendMenuItem(title);
            item.connect('activate', () => {
                this.emit('activate-window', window);
            });
        });

        if (!this._source.app.is_window_backed()) {
            this._appendSeparator();

            let appInfo = this._source.app.get_app_info();
            let actions = appInfo.list_actions();
            if (this._source.app.can_open_new_window() &&
                !actions.includes('new-window')) {
                this._newWindowMenuItem = this._appendMenuItem(_("New Window"));
                this._newWindowMenuItem.connect('activate', () => {
                    this._source.animateLaunch();
                    this._source.app.open_new_window(-1);
                    this.emit('activate-window', null);
                });
                this._appendSeparator();
            }

            if (discreteGpuAvailable &&
                this._source.app.state == Shell.AppState.STOPPED &&
                !actions.includes('activate-discrete-gpu')) {
                this._onDiscreteGpuMenuItem = this._appendMenuItem(_("Launch using Dedicated Graphics Card"));
                this._onDiscreteGpuMenuItem.connect('activate', () => {
                    this._source.animateLaunch();
                    this._source.app.launch(0, -1, true);
                    this.emit('activate-window', null);
                });
            }

            for (let i = 0; i < actions.length; i++) {
                let action = actions[i];
                let item = this._appendMenuItem(appInfo.get_action_name(action));
                item.connect('activate', (emitter, event) => {
                    if (action == 'new-window' ||
                        action == 'activate-discrete-gpu')
                        this._source.animateLaunch();

                    this._source.app.launch_action(action, event.get_time(), -1);
                    this.emit('activate-window', null);
                });
            }

            let canFavorite = global.settings.is_writable('favorite-apps');

            if (canFavorite) {
                this._appendSeparator();

                let isFavorite = AppFavorites.getAppFavorites().isFavorite(this._source.app.get_id());

                if (isFavorite) {
                    let item = this._appendMenuItem(_("Remove from Favorites"));
                    item.connect('activate', () => {
                        let favs = AppFavorites.getAppFavorites();
                        favs.removeFavorite(this._source.app.get_id());
                    });
                } else {
                    let item = this._appendMenuItem(_("Add to Favorites"));
                    item.connect('activate', () => {
                        let favs = AppFavorites.getAppFavorites();
                        favs.addFavorite(this._source.app.get_id());
                    });
                }
            }

            if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop')) {
                this._appendSeparator();
                let item = this._appendMenuItem(_("Show Details"));
                item.connect('activate', () => {
                    let id = this._source.app.get_id();
                    let args = GLib.Variant.new('(ss)', [id, '']);
                    Gio.DBus.get(Gio.BusType.SESSION, null, (o, res) => {
                        let bus = Gio.DBus.get_finish(res);
                        bus.call('org.gnome.Software',
                                 '/org/gnome/Software',
                                 'org.gtk.Actions', 'Activate',
                                 GLib.Variant.new('(sava{sv})',
                                                  ['details', [args], null]),
                                 null, 0, -1, null, null);
                        Main.overview.hide();
                    });
                });
            }
        }
    }

    _appendSeparator() {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    }

    _appendMenuItem(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    }

    popup(_activatingButton) {
        this._redisplay();
        this.open();
    }
};
Signals.addSignalMethods(AppIconMenu.prototype);

var SystemActionIcon = class SystemActionIcon extends Search.GridSearchResult {
    activate() {
        SystemActions.getDefault().activateAction(this.metaInfo['id']);
        Main.overview.hide();
    }
};
