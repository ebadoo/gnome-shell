// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Keyboard */

const { Clutter, Gio, GLib, GObject, Meta, St } = imports.gi;
const Signals = imports.signals;

const InputSourceManager = imports.ui.status.keyboard;
const IBusManager = imports.misc.ibusManager;
const BoxPointer = imports.ui.boxpointer;
const Layout = imports.ui.layout;
const Main = imports.ui.main;
const PageIndicators = imports.ui.pageIndicators;
const PopupMenu = imports.ui.popupMenu;

var KEYBOARD_REST_TIME = Layout.KEYBOARD_ANIMATION_TIME * 2;
var KEY_LONG_PRESS_TIME = 250;
var PANEL_SWITCH_ANIMATION_TIME = 500;
var PANEL_SWITCH_RELATIVE_DISTANCE = 1 / 3; /* A third of the actor width */

const A11Y_APPLICATIONS_SCHEMA = 'org.gnome.desktop.a11y.applications';
const SHOW_KEYBOARD = 'screen-keyboard-enabled';

/* KeyContainer puts keys in a grid where a 1:1 key takes this size */
const KEY_SIZE = 2;

const defaultKeysPre = [
    [[], [], [{ width: 1.5, level: 1, extraClassName: 'shift-key-lowercase' }], [{ label: '?123', width: 1.5, level: 2 }]],
    [[], [], [{ width: 1.5, level: 0, extraClassName: 'shift-key-uppercase' }], [{ label: '?123', width: 1.5, level: 2 }]],
    [[], [], [{ label: '=/<', width: 1.5, level: 3 }], [{ label: 'ABC', width: 1.5, level: 0 }]],
    [[], [], [{ label: '?123', width: 1.5, level: 2 }], [{ label: 'ABC', width: 1.5, level: 0 }]],
];

const defaultKeysPost = [
    [[{ label: '⌫', width: 1.5, keyval: Clutter.KEY_BackSpace }],
     [{ width: 2, keyval: Clutter.KEY_Return, extraClassName: 'enter-key' }],
     [{ width: 3, level: 1, right: true, extraClassName: 'shift-key-lowercase' }],
     [{ label: '☻', action: 'emoji' }, { action: 'languageMenu', extraClassName: 'layout-key' }, { action: 'hide', extraClassName: 'hide-key' }]],
    [[{ label: '⌫', width: 1.5, keyval: Clutter.KEY_BackSpace }],
     [{ width: 2, keyval: Clutter.KEY_Return, extraClassName: 'enter-key' }],
     [{ width: 3, level: 0, right: true, extraClassName: 'shift-key-uppercase' }],
     [{ label: '☻', action: 'emoji' }, { action: 'languageMenu', extraClassName: 'layout-key' }, { action: 'hide', extraClassName: 'hide-key' }]],
    [[{ label: '⌫', width: 1.5, keyval: Clutter.KEY_BackSpace }],
     [{ width: 2, keyval: Clutter.KEY_Return, extraClassName: 'enter-key' }],
     [{ label: '=/<', width: 3, level: 3, right: true }],
     [{ label: '☻', action: 'emoji' }, { action: 'languageMenu', extraClassName: 'layout-key' }, { action: 'hide', extraClassName: 'hide-key' }]],
    [[{ label: '⌫', width: 1.5, keyval: Clutter.KEY_BackSpace }],
     [{ width: 2, keyval: Clutter.KEY_Return, extraClassName: 'enter-key' }],
     [{ label: '?123', width: 3, level: 2, right: true }],
     [{ label: '☻', action: 'emoji' }, { action: 'languageMenu', extraClassName: 'layout-key' }, { action: 'hide', extraClassName: 'hide-key' }]],
];

var AspectContainer = GObject.registerClass(
class AspectContainer extends St.Widget {
    _init(params) {
        super._init(params);
        this._ratio = 1;
    }

    setRatio(relWidth, relHeight) {
        this._ratio = relWidth / relHeight;
        this.queue_relayout();
    }

    vfunc_allocate(box, flags) {
        if (box.get_width() > 0 && box.get_height() > 0) {
            let sizeRatio = box.get_width() / box.get_height();

            if (sizeRatio >= this._ratio) {
                /* Restrict horizontally */
                let width = box.get_height() * this._ratio;
                let diff = box.get_width() - width;

                box.x1 += Math.floor(diff / 2);
                box.x2 -= Math.ceil(diff / 2);
            } else {
                /* Restrict vertically, align to bottom */
                let height = box.get_width() / this._ratio;
                box.y1 = box.y2 - Math.floor(height);
            }
        }

        super.vfunc_allocate(box, flags);
    }
});

var KeyContainer = GObject.registerClass(
class KeyContainer extends St.Widget {
    _init() {
        let gridLayout = new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL,
                                                  column_homogeneous: true,
                                                  row_homogeneous: true });
        super._init({ layout_manager: gridLayout,
                      x_expand: true, y_expand: true });
        this._gridLayout = gridLayout;
        this._currentRow = 0;
        this._currentCol = 0;
        this._maxCols = 0;

        this._currentRow = null;
        this._rows = [];
    }

    appendRow() {
        this._currentRow++;
        this._currentCol = 0;

        let row = {
            keys: [],
            width: 0,
        };
        this._rows.push(row);
    }

    appendKey(key, width = 1, height = 1) {
        let keyInfo = {
            key,
            left: this._currentCol,
            top: this._currentRow,
            width,
            height
        };

        let row = this._rows[this._rows.length - 1];
        row.keys.push(keyInfo);
        row.width += width;

        this._currentCol += width;
        this._maxCols = Math.max(this._currentCol, this._maxCols);
    }

    layoutButtons(container) {
        let nCol = 0, nRow = 0;

        for (let i = 0; i < this._rows.length; i++) {
            let row = this._rows[i];

            /* When starting a new row, see if we need some padding */
            if (nCol == 0) {
                let diff = this._maxCols - row.width;
                if (diff >= 1)
                    nCol = diff * KEY_SIZE / 2;
                else
                    nCol = diff * KEY_SIZE;
            }

            for (let j = 0; j < row.keys.length; j++) {
                let keyInfo = row.keys[j];
                let width = keyInfo.width * KEY_SIZE;
                let height = keyInfo.height * KEY_SIZE;

                this._gridLayout.attach(keyInfo.key, nCol, nRow, width, height);
                nCol += width;
            }

            nRow += KEY_SIZE;
            nCol = 0;
        }

        if (container)
            container.setRatio(this._maxCols, this._rows.length);
    }
});

var Suggestions = class {
    constructor() {
        this.actor = new St.BoxLayout({ style_class: 'word-suggestions',
                                        vertical: false });
        this.actor.show();
    }

    add(word, callback) {
        let button = new St.Button({ label: word });
        button.connect('clicked', callback);
        this.actor.add(button);
    }

    clear() {
        this.actor.remove_all_children();
    }
};
Signals.addSignalMethods(Suggestions.prototype);

var LanguageSelectionPopup = class extends PopupMenu.PopupMenu {
    constructor(actor) {
        super(actor, 0.5, St.Side.BOTTOM);

        let inputSourceManager = InputSourceManager.getInputSourceManager();
        let inputSources = inputSourceManager.inputSources;

        let item;
        for (let i in inputSources) {
            let is = inputSources[i];

            item = this.addAction(is.displayName, () => {
                inputSourceManager.activateInputSource(is, true);
            });
            item.can_focus = false;
        }

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        item = this.addSettingsAction(_("Region & Language Settings"), 'gnome-region-panel.desktop');
        item.can_focus = false;

        this._capturedEventId = 0;

        this._unmapId = actor.connect('notify::mapped', () => {
            if (!actor.is_mapped())
                this.close(true);
        });
    }

    _onCapturedEvent(actor, event) {
        if (event.get_source() == this.actor ||
            this.actor.contains(event.get_source()))
            return Clutter.EVENT_PROPAGATE;

        if (event.type() == Clutter.EventType.BUTTON_RELEASE || event.type() == Clutter.EventType.TOUCH_END)
            this.close(true);

        return Clutter.EVENT_STOP;
    }

    open(animate) {
        super.open(animate);
        this._capturedEventId = global.stage.connect('captured-event',
                                                     this._onCapturedEvent.bind(this));
    }

    close(animate) {
        super.close(animate);
        if (this._capturedEventId != 0) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
    }

    destroy() {
        if (this._capturedEventId != 0)
            global.stage.disconnect(this._capturedEventId);
        if (this._unmapId != 0)
            this.sourceActor.disconnect(this._unmapId);
        super.destroy();
    }
};

var Key = class Key {
    constructor(key, extendedKeys) {
        this.key = key || "";
        this.keyButton = this._makeKey(this.key);

        /* Add the key in a container, so keys can be padded without losing
         * logical proportions between those.
         */
        this.actor = new St.BoxLayout ({ style_class: 'key-container' });
        this.actor.add(this.keyButton, { expand: true, x_fill: true });
        this.actor.connect('destroy', this._onDestroy.bind(this));

        this._extended_keys = extendedKeys;
        this._extended_keyboard = null;
        this._pressTimeoutId = 0;
        this._capturedPress = false;

        this._capturedEventId = 0;
        this._unmapId = 0;
        this._longPress = false;
    }

    _onDestroy() {
        if (this._boxPointer) {
            this._boxPointer.destroy();
            this._boxPointer = null;
        }

        this.cancel();
    }

    _ensureExtendedKeysPopup() {
        if (this._extended_keys.length == 0)
            return;

        this._boxPointer = new BoxPointer.BoxPointer(St.Side.BOTTOM,
                                                     { x_fill: true,
                                                       y_fill: true,
                                                       x_align: St.Align.START });
        this._boxPointer.hide();
        Main.layoutManager.addTopChrome(this._boxPointer);
        this._boxPointer.setPosition(this.keyButton, 0.5);

        // Adds style to existing keyboard style to avoid repetition
        this._boxPointer.add_style_class_name('keyboard-subkeys');
        this._getExtendedKeys();
        this.keyButton._extended_keys = this._extended_keyboard;
    }

    _getKeyval(key) {
        let unicode = key.charCodeAt(0);
        return Clutter.unicode_to_keysym(unicode);
    }

    _press(key) {
        this.emit('activated');

        if (key != this.key || this._extended_keys.length == 0) {
            this.emit('pressed', this._getKeyval(key), key);
        }

        if (key == this.key) {
            this._pressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                                    KEY_LONG_PRESS_TIME,
                                                    () => {
                                                        this._longPress = true;
                                                        this._pressTimeoutId = 0;

                                                        this.emit('long-press');

                                                        if (this._extended_keys.length > 0) {
                                                            this._touchPressed = false;
                                                            this.keyButton.set_hover(false);
                                                            this.keyButton.fake_release();
                                                            this._ensureExtendedKeysPopup();
                                                            this._showSubkeys();
                                                        }

                                                        return GLib.SOURCE_REMOVE;
                                                    });
        }
    }

    _release(key) {
        if (this._pressTimeoutId != 0) {
            GLib.source_remove(this._pressTimeoutId);
            this._pressTimeoutId = 0;
        }

        if (!this._longPress && key == this.key && this._extended_keys.length > 0)
            this.emit('pressed', this._getKeyval(key), key);

        this.emit('released', this._getKeyval(key), key);
        this._hideSubkeys();
        this._longPress = false;
    }

    cancel() {
        if (this._pressTimeoutId != 0) {
            GLib.source_remove(this._pressTimeoutId);
            this._pressTimeoutId = 0;
        }
        this._touchPressed = false;
        this.keyButton.set_hover(false);
        this.keyButton.fake_release();
    }

    _onCapturedEvent(actor, event) {
        let type = event.type();
        let press = (type == Clutter.EventType.BUTTON_PRESS || type == Clutter.EventType.TOUCH_BEGIN);
        let release = (type == Clutter.EventType.BUTTON_RELEASE || type == Clutter.EventType.TOUCH_END);

        if (event.get_source() == this._boxPointer.bin ||
            this._boxPointer.bin.contains(event.get_source()))
            return Clutter.EVENT_PROPAGATE;

        if (press)
            this._capturedPress = true;
        else if (release && this._capturedPress)
            this._hideSubkeys();

        return Clutter.EVENT_STOP;
    }

    _showSubkeys() {
        this._boxPointer.open(BoxPointer.PopupAnimation.FULL);
        this._capturedEventId = global.stage.connect('captured-event',
                                                     this._onCapturedEvent.bind(this));
        this._unmapId = this.keyButton.connect('notify::mapped', () => {
            if (!this.keyButton.is_mapped())
                this._hideSubkeys();
        });
    }

    _hideSubkeys() {
        if (this._boxPointer)
            this._boxPointer.close(BoxPointer.PopupAnimation.FULL);
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
        if (this._unmapId) {
            this.keyButton.disconnect(this._unmapId);
            this._unmapId = 0;
        }
        this._capturedPress = false;
    }

    _makeKey(key) {
        let label = GLib.markup_escape_text(key, -1);
        let button = new St.Button ({ label: label,
                                      style_class: 'keyboard-key' });

        button.keyWidth = 1;
        button.connect('button-press-event', () => {
            this._press(key);
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('button-release-event', () => {
            this._release(key);
            return Clutter.EVENT_PROPAGATE;
        });
        button.connect('touch-event', (actor, event) => {
            // We only handle touch events here on wayland. On X11
            // we do get emulated pointer events, which already works
            // for single-touch cases. Besides, the X11 passive touch grab
            // set up by Mutter will make us see first the touch events
            // and later the pointer events, so it will look like two
            // unrelated series of events, we want to avoid double handling
            // in these cases.
            if (!Meta.is_wayland_compositor())
                return Clutter.EVENT_PROPAGATE;

            if (!this._touchPressed &&
                event.type() == Clutter.EventType.TOUCH_BEGIN) {
                this._touchPressed = true;
                this._press(key);
            } else if (this._touchPressed &&
                       event.type() == Clutter.EventType.TOUCH_END) {
                this._touchPressed = false;
                this._release(key);
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return button;
    }

    _getExtendedKeys() {
        this._extended_keyboard = new St.BoxLayout({ style_class: 'key-container',
                                                     vertical: false });
        for (let i = 0; i < this._extended_keys.length; ++i) {
            let extendedKey = this._extended_keys[i];
            let key = this._makeKey(extendedKey);

            key.extended_key = extendedKey;
            this._extended_keyboard.add(key);

            key.width = this.keyButton.width;
            key.height = this.keyButton.height;
        }
        this._boxPointer.bin.add_actor(this._extended_keyboard);
    }

    get subkeys() {
        return this._boxPointer;
    }

    setWidth(width) {
        this.keyButton.keyWidth = width;
    }

    setLatched(latched) {
        if (latched)
            this.keyButton.add_style_pseudo_class('latched');
        else
            this.keyButton.remove_style_pseudo_class('latched');
    }
};
Signals.addSignalMethods(Key.prototype);

var KeyboardModel = class {
    constructor(groupName) {
        try {
            this._model = this._loadModel(groupName);
        } catch (e) {
            this._model = this._loadModel('us');
        }
    }

    _loadModel(groupName) {
        let file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/%s.json'.format(groupName));
        let [success_, contents] = file.load_contents(null);
        if (contents instanceof Uint8Array)
            contents = imports.byteArray.toString(contents);

        return JSON.parse(contents);
    }

    getLevels() {
        return this._model.levels;
    }

    getKeysForLevel(levelName) {
        return this._model.levels.find(level => level == levelName);
    }
};

var FocusTracker = class {
    constructor() {
        this._currentWindow = null;
        this._rect = null;

        global.display.connect('notify::focus-window', () => {
            this._setCurrentWindow(global.display.focus_window);
            this.emit('window-changed', this._currentWindow);
        });

        global.display.connect('grab-op-begin', (display, window, op) => {
            if (window == this._currentWindow &&
                (op == Meta.GrabOp.MOVING || op == Meta.GrabOp.KEYBOARD_MOVING))
                this.emit('reset');
        });

        /* Valid for wayland clients */
        Main.inputMethod.connect('cursor-location-changed', (o, rect) => {
            let newRect = { x: rect.get_x(), y: rect.get_y(), width: rect.get_width(), height: rect.get_height() };
            this._setCurrentRect(newRect);
        });

        this._ibusManager = IBusManager.getIBusManager();
        this._ibusManager.connect('set-cursor-location', (manager, rect) => {
            /* Valid for X11 clients only */
            if (Main.inputMethod.currentFocus)
                return;

            this._setCurrentRect(rect);
        });
        this._ibusManager.connect('focus-in', () => {
            this.emit('focus-changed', true);
        });
        this._ibusManager.connect('focus-out', () => {
            this.emit('focus-changed', false);
        });
    }

    get currentWindow() {
        return this._currentWindow;
    }

    _setCurrentWindow(window) {
        this._currentWindow = window;
    }

    _setCurrentRect(rect) {
        if (this._currentWindow) {
            let frameRect = this._currentWindow.get_frame_rect();
            rect.x -= frameRect.x;
            rect.y -= frameRect.y;
        }

        if (this._rect &&
            this._rect.x == rect.x &&
            this._rect.y == rect.y &&
            this._rect.width == rect.width &&
            this._rect.height == rect.height)
            return;

        this._rect = rect;
        this.emit('position-changed');
    }

    getCurrentRect() {
        let rect = { x: this._rect.x, y: this._rect.y,
                     width: this._rect.width, height: this._rect.height };

        if (this._currentWindow) {
            let frameRect = this._currentWindow.get_frame_rect();
            rect.x += frameRect.x;
            rect.y += frameRect.y;
        }

        return rect;
    }
};
Signals.addSignalMethods(FocusTracker.prototype);

var EmojiPager = GObject.registerClass({
    Properties: {
        'delta': GObject.ParamSpec.int(
            'delta', 'delta', 'delta',
            GObject.ParamFlags.READWRITE,
            GLib.MININT32, GLib.MAXINT32, 0)
    },
    Signals: {
        'emoji': { param_types: [GObject.TYPE_STRING] },
        'page-changed': {
            param_types: [GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_INT]
        }
    }
}, class EmojiPager extends St.Widget {
    _init(sections, nCols, nRows) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: true
        });

        this._sections = sections;
        this._nCols = nCols;
        this._nRows = nRows;

        this._pages = [];
        this._panel = null;
        this._curPage = null;
        this._followingPage = null;
        this._followingPanel = null;
        this._currentKey = null;
        this._delta = 0;
        this._width = null;

        this._initPagingInfo();

        let panAction = new Clutter.PanAction({ interpolate: false });
        panAction.connect('pan', this._onPan.bind(this));
        panAction.connect('gesture-begin', this._onPanBegin.bind(this));
        panAction.connect('gesture-cancel', this._onPanCancel.bind(this));
        panAction.connect('gesture-end', this._onPanEnd.bind(this));
        this._panAction = panAction;
        this.add_action(panAction);
    }

    get delta() {
        return this._delta;
    }

    set delta(value) {
        if (value > this._width)
            value = this._width;
        else if (value < -this._width)
            value = -this._width;

        if (this._delta == value)
            return;

        this._delta = value;
        this.notify('delta');

        if (value == 0)
            return;

        let relValue = Math.abs(value / this._width);
        let followingPage = this.getFollowingPage();

        if (this._followingPage != followingPage) {
            if (this._followingPanel) {
                this._followingPanel.destroy();
                this._followingPanel = null;
            }

            if (followingPage != null) {
                this._followingPanel = this._generatePanel(followingPage);
                this._followingPanel.set_pivot_point(0.5, 0.5);
                this.add_child(this._followingPanel);
                this.set_child_below_sibling(this._followingPanel, this._panel);
            }

            this._followingPage = followingPage;
        }

        this._panel.translation_x = value;
        this._panel.opacity = 255 * (1 - Math.pow(relValue, 3));

        if (this._followingPanel) {
            this._followingPanel.scale_x = 0.8 + (0.2 * relValue);
            this._followingPanel.scale_y = 0.8 + (0.2 * relValue);
            this._followingPanel.opacity = 255 * relValue;
        }
    }

    _prevPage(nPage) {
        return (nPage + this._pages.length - 1) % this._pages.length;
    }

    _nextPage(nPage) {
        return (nPage + 1) % this._pages.length;
    }

    getFollowingPage() {
        if (this.delta == 0)
            return null;

        if ((this.delta < 0 && global.stage.text_direction == Clutter.TextDirection.LTR) ||
            (this.delta > 0 && global.stage.text_direction == Clutter.TextDirection.RTL))
            return this._nextPage(this._curPage);
        else
            return this._prevPage(this._curPage);
    }

    _onPan(action) {
        let [dist_, dx, dy_] = action.get_motion_delta(0);
        this.delta = this.delta + dx;

        if (this._currentKey != null) {
            this._currentKey.cancel();
            this._currentKey = null;
        }

        return false;
    }

    _onPanBegin() {
        this._width = this.width;
        return true;
    }

    _onPanEnd() {
        if (Math.abs(this._delta) < this.width * PANEL_SWITCH_RELATIVE_DISTANCE) {
            this._onPanCancel();
        } else {
            let value;
            if (this._delta > 0)
                value = this._width;
            else if (this._delta < 0)
                value = -this._width;

            let relDelta = Math.abs(this._delta - value) / this._width;
            let time = PANEL_SWITCH_ANIMATION_TIME * Math.abs(relDelta);

            this.remove_all_transitions();
            this.ease_property('delta', value, {
                duration: time,
                onComplete: () => {
                    this.setCurrentPage(this.getFollowingPage());
                }
            });
        }
    }

    _onPanCancel() {
        let relDelta = Math.abs(this._delta) / this.width;
        let time = PANEL_SWITCH_ANIMATION_TIME * Math.abs(relDelta);

        this.remove_all_transitions();
        this.ease_property('delta', 0, {
            duration: time,
        });
    }

    _initPagingInfo() {
        for (let i = 0; i < this._sections.length; i++) {
            let section = this._sections[i];
            let itemsPerPage = this._nCols * this._nRows;
            let nPages = Math.ceil(section.keys.length / itemsPerPage);
            let page = -1;
            let pageKeys;

            for (let j = 0; j < section.keys.length; j++) {
                if (j % itemsPerPage == 0) {
                    page++;
                    pageKeys = [];
                    this._pages.push({ pageKeys, nPages, page, section: this._sections[i] });
                }

                pageKeys.push(section.keys[j]);
            }
        }
    }

    _lookupSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            let page = this._pages[i];

            if (page.section == section && page.page == nPage)
                return i;
        }

        return -1;
    }

    _generatePanel(nPage) {
        let gridLayout = new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL,
                                                  column_homogeneous: true,
                                                  row_homogeneous: true });
        let panel = new St.Widget({ layout_manager: gridLayout,
                                    style_class: 'emoji-page',
                                    x_expand: true,
                                    y_expand: true });

        /* Set an expander actor so all proportions are right despite the panel
         * not having all rows/cols filled in.
         */
        let expander = new Clutter.Actor();
        gridLayout.attach(expander, 0, 0, this._nCols, this._nRows);

        let page = this._pages[nPage];
        let col = 0;
        let row = 0;

        for (let i = 0; i < page.pageKeys.length; i++) {
            let modelKey = page.pageKeys[i];
            let key = new Key(modelKey.label, modelKey.variants);

            key.keyButton.set_button_mask(0);

            key.connect('activated', () => {
                this._currentKey = key;
            });
            key.connect('long-press', () => {
                this._panAction.cancel();
            });
            key.connect('released', (actor, keyval, str) => {
                if (this._currentKey != key)
                    return;
                this._currentKey = null;
                this.emit('emoji', str);
            });

            gridLayout.attach(key.actor, col, row, 1, 1);

            col++;
            if (col >= this._nCols) {
                col = 0;
                row++;
            }
        }

        return panel;
    }

    setCurrentPage(nPage) {
        if (this._curPage == nPage)
            return;

        this._curPage = nPage;

        if (this._panel) {
            this._panel.destroy();
            this._panel = null;
        }

        /* Reuse followingPage if possible */
        if (nPage == this._followingPage) {
            this._panel = this._followingPanel;
            this._followingPanel = null;
        }

        if (this._followingPanel)
            this._followingPanel.destroy();

        this._followingPanel = null;
        this._followingPage = null;
        this._delta = 0;

        if (!this._panel) {
            this._panel = this._generatePanel(nPage);
            this.add_child(this._panel);
        }

        let page = this._pages[nPage];
        this.emit('page-changed', page.section, page.page, page.nPages);
    }

    setCurrentSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            let page = this._pages[i];

            if (page.section == section && page.page == nPage) {
                this.setCurrentPage(i);
                break;
            }
        }
    }
});

var EmojiSelection = class EmojiSelection {
    constructor() {
        this._sections = [
            { first: 'grinning face', label: '🙂️' },
            { first: 'selfie', label: '👍️' },
            { first: 'monkey face', label: '🌷️' },
            { first: 'grapes', label: '🍴️' },
            { first: 'globe showing Europe-Africa', label: '✈️' },
            { first: 'jack-o-lantern', label: '🏃️' },
            { first: 'muted speaker', label: '🔔️' },
            { first: 'ATM sign', label: '❤️' },
            { first: 'chequered flag', label: '🚩️' },
        ];

        this._populateSections();

        this.actor = new St.BoxLayout({ style_class: 'emoji-panel',
                                        x_expand: true,
                                        y_expand: true,
                                        vertical: true });
        this.actor.connect('notify::mapped', () => this._emojiPager.setCurrentPage(0));

        this._emojiPager = new EmojiPager(this._sections, 11, 3);
        this._emojiPager.connect('page-changed', (pager, section, page, nPages) => {
            this._onPageChanged(section, page, nPages);
        });
        this._emojiPager.connect('emoji', (pager, str) => {
            this.emit('emoji-selected', str);
        });
        this.actor.add(this._emojiPager.actor, { expand: true });

        this._pageIndicator = new PageIndicators.PageIndicators(false);
        this.actor.add(this._pageIndicator, { expand: true, x_fill: false, y_fill: false });
        this._pageIndicator.setReactive(false);

        let bottomRow = this._createBottomRow();
        this.actor.add(bottomRow, { expand: true, x_fill: false, y_fill: false });

        this._emojiPager.setCurrentPage(0);
    }

    _onPageChanged(section, page, nPages) {
        this._pageIndicator.setNPages(nPages);
        this._pageIndicator.setCurrentPage(page);

        for (let i = 0; i < this._sections.length; i++) {
            let sect = this._sections[i];
            sect.button.setLatched(section == sect);
        }
    }

    _findSection(emoji) {
        for (let i = 0; i < this._sections.length; i++) {
            if (this._sections[i].first == emoji)
                return this._sections[i];
        }

        return null;
    }

    _populateSections() {
        let file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/emoji.json');
        let [success_, contents] = file.load_contents(null);

        if (contents instanceof Uint8Array)
            contents = imports.byteArray.toString(contents);
        let emoji = JSON.parse(contents);

        let variants = [];
        let currentKey = 0;
        let currentSection = null;

        for (let i = 0; i < emoji.length; i++) {
            /* Group variants of a same emoji so they appear on the key popover */
            if (emoji[i].name.startsWith(emoji[currentKey].name)) {
                variants.push(emoji[i].char);
                if (i < emoji.length - 1)
                    continue;
            }

            let newSection = this._findSection(emoji[currentKey].name);
            if (newSection != null) {
                currentSection = newSection;
                currentSection.keys = [];
            }

            /* Create the key */
            let label = emoji[currentKey].char + String.fromCharCode(0xFE0F);
            currentSection.keys.push({ label, variants });
            currentKey = i;
            variants = [];
        }
    }

    _createBottomRow() {
        let row = new KeyContainer();
        let key;

        row.appendRow();

        key = new Key('ABC', []);
        key.keyButton.add_style_class_name('default-key');
        key.connect('released', () => this.emit('toggle'));
        row.appendKey(key.actor, 1.5);

        for (let i = 0; i < this._sections.length; i++) {
            let section = this._sections[i];

            key = new Key(section.label, []);
            key.connect('released', () => this._emojiPager.setCurrentSection(section, 0));
            row.appendKey(key.actor);

            section.button = key;
        }

        key = new Key(null, []);
        key.keyButton.add_style_class_name('default-key');
        key.keyButton.add_style_class_name('hide-key');
        key.connect('released', () => {
            this.emit('hide');
        });
        row.appendKey(key.actor);
        row.layoutButtons();

        let actor = new AspectContainer({ layout_manager: new Clutter.BinLayout(),
                                          x_expand: true, y_expand: true });
        actor.add_child(row);
        /* Regular keyboard layouts are 11.5×4 grids, optimize for that
         * at the moment. Ideally this should be as wide as the current
         * keymap.
         */
        actor.setRatio(11.5, 1);

        return actor;
    }
};
Signals.addSignalMethods(EmojiSelection.prototype);

var Keypad = class Keypad {
    constructor() {
        let keys = [
            { label: '1', keyval: Clutter.KEY_1, left: 0, top: 0 },
            { label: '2', keyval: Clutter.KEY_2, left: 1, top: 0 },
            { label: '3', keyval: Clutter.KEY_3, left: 2, top: 0 },
            { label: '4', keyval: Clutter.KEY_4, left: 0, top: 1 },
            { label: '5', keyval: Clutter.KEY_5, left: 1, top: 1 },
            { label: '6', keyval: Clutter.KEY_6, left: 2, top: 1 },
            { label: '7', keyval: Clutter.KEY_7, left: 0, top: 2 },
            { label: '8', keyval: Clutter.KEY_8, left: 1, top: 2 },
            { label: '9', keyval: Clutter.KEY_9, left: 2, top: 2 },
            { label: '0', keyval: Clutter.KEY_0, left: 1, top: 3 },
            { label: '⌫', keyval: Clutter.KEY_BackSpace, left: 3, top: 0 },
            { keyval: Clutter.KEY_Return, extraClassName: 'enter-key', left: 3, top: 1, height: 2 },
        ];

        this.actor = new AspectContainer({ layout_manager: new Clutter.BinLayout(),
                                           x_expand: true, y_expand: true });

        let gridLayout = new Clutter.GridLayout({ orientation: Clutter.Orientation.HORIZONTAL,
                                                  column_homogeneous: true,
                                                  row_homogeneous: true });
        this._box = new St.Widget({ layout_manager: gridLayout, x_expand: true, y_expand: true });
        this.actor.add_child(this._box);

        for (let i = 0; i < keys.length; i++) {
            let cur = keys[i];
            let key = new Key(cur.label || "", []);

            if (keys[i].extraClassName)
                key.keyButton.add_style_class_name(cur.extraClassName);

            let w, h;
            w = cur.width || 1;
            h = cur.height || 1;
            gridLayout.attach(key.actor, cur.left, cur.top, w, h);

            key.connect('released', () => {
                this.emit('keyval', cur.keyval);
            });
        }
    }
};
Signals.addSignalMethods(Keypad.prototype);

var Keyboard = class Keyboard {
    constructor() {
        this.actor = null;
        this._focusInExtendedKeys = false;
        this._emojiActive = false;

        this._languagePopup = null;
        this._currentFocusWindow = null;
        this._animFocusedWindow = null;
        this._delayedAnimFocusWindow = null;

        this._enableKeyboard = false; // a11y settings value
        this._enabled = false; // enabled state (by setting or device type)
        this._latched = false; // current level is latched

        this._a11yApplicationsSettings = new Gio.Settings({ schema_id: A11Y_APPLICATIONS_SCHEMA });
        this._a11yApplicationsSettings.connect('changed', this._syncEnabled.bind(this));
        this._lastDeviceId = null;
        this._suggestions = null;
        this._emojiKeyVisible = Meta.is_wayland_compositor();

        this._focusTracker = new FocusTracker();
        this._focusTracker.connect('position-changed', this._onFocusPositionChanged.bind(this));
        this._focusTracker.connect('reset', () => {
            this._delayedAnimFocusWindow = null;
            this._animFocusedWindow = null;
            this._oskFocusWindow = null;
        });
        this._focusTracker.connect('focus-changed', (tracker, focused) => {
            // Valid only for X11
            if (Meta.is_wayland_compositor())
                return;

            if (focused)
                this.show(Main.layoutManager.focusIndex);
            else
                this.hide();
        });

        Meta.get_backend().connect('last-device-changed',
            (backend, deviceId) => {
                let manager = Clutter.DeviceManager.get_default();
                let device = manager.get_device(deviceId);

                if (!device.get_device_name().includes('XTEST')) {
                    this._lastDeviceId = deviceId;
                    this._syncEnabled();
                }
            });
        this._syncEnabled();

        this._showIdleId = 0;

        this._keyboardVisible = false;
        Main.layoutManager.connect('keyboard-visible-changed', (o, visible) => {
            this._keyboardVisible = visible;
        });
        this._keyboardRequested = false;
        this._keyboardRestingId = 0;

        Main.layoutManager.connect('monitors-changed', this._relayout.bind(this));
    }

    get visible() {
        return this._keyboardVisible;
    }

    _onFocusPositionChanged(focusTracker) {
        let rect = focusTracker.getCurrentRect();
        this.setCursorLocation(focusTracker.currentWindow, rect.x, rect.y, rect.width, rect.height);
    }

    _lastDeviceIsTouchscreen() {
        if (!this._lastDeviceId)
            return false;

        let manager = Clutter.DeviceManager.get_default();
        let device = manager.get_device(this._lastDeviceId);

        if (!device)
            return false;

        return device.get_device_type() == Clutter.InputDeviceType.TOUCHSCREEN_DEVICE;
    }

    _syncEnabled() {
        let wasEnabled = this._enabled;
        this._enableKeyboard = this._a11yApplicationsSettings.get_boolean(SHOW_KEYBOARD);
        this._enabled = this._enableKeyboard || this._lastDeviceIsTouchscreen();
        if (!this._enabled && !this._keyboardController)
            return;

        if (this._enabled && !this._keyboardController)
            this._setupKeyboard();
        else if (!this._enabled)
            this.setCursorLocation(null);

        if (!this._enabled && wasEnabled)
            Main.layoutManager.hideKeyboard(true);
    }

    _destroyKeyboard() {
        if (this._keyboardNotifyId)
            this._keyboardController.disconnect(this._keyboardNotifyId);
        if (this._keyboardGroupsChangedId)
            this._keyboardController.disconnect(this._keyboardGroupsChangedId);
        if (this._keyboardStateId)
            this._keyboardController.disconnect(this._keyboardStateId);
        if (this._emojiKeyVisibleId)
            this._keyboardController.disconnect(this._emojiKeyVisibleId);
        if (this._keypadVisibleId)
            this._keyboardController.disconnect(this._keypadVisibleId);
        if (this._focusNotifyId)
            global.stage.disconnect(this._focusNotifyId);
        this._clearShowIdle();
        this._keyboard = null;
        this.actor.destroy();
        this.actor = null;

        if (this._languagePopup) {
            this._languagePopup.destroy();
            this._languagePopup = null;
        }
    }

    _setupKeyboard() {
        this.actor = new St.BoxLayout({ name: 'keyboard', vertical: true, reactive: true });
        Main.layoutManager.keyboardBox.add_actor(this.actor);
        Main.layoutManager.trackChrome(this.actor);

        this._keyboardController = new KeyboardController();

        this._groups = {};
        this._currentPage = null;

        this._suggestions = new Suggestions();
        this.actor.add(this._suggestions.actor,
                       { x_align: St.Align.MIDDLE,
                         x_fill: false });

        this._aspectContainer = new AspectContainer({ layout_manager: new Clutter.BinLayout() });
        this.actor.add(this._aspectContainer, { expand: true });

        this._emojiSelection = new EmojiSelection();
        this._emojiSelection.connect('toggle', this._toggleEmoji.bind(this));
        this._emojiSelection.connect('hide', () => this.hide());
        this._emojiSelection.connect('emoji-selected', (selection, emoji) => {
            this._keyboardController.commitString(emoji);
        });

        this._aspectContainer.add_child(this._emojiSelection.actor);
        this._emojiSelection.actor.hide();

        this._keypad = new Keypad();
        this._keypad.connect('keyval', (keypad, keyval) => {
            this._keyboardController.keyvalPress(keyval);
            this._keyboardController.keyvalRelease(keyval);
        });
        this._aspectContainer.add_child(this._keypad.actor);
        this._keypad.actor.hide();
        this._keypadVisible = false;

        this._ensureKeysForGroup(this._keyboardController.getCurrentGroup());
        this._setActiveLayer(0);

        // Keyboard models are defined in LTR, we must override
        // the locale setting in order to avoid flipping the
        // keyboard on RTL locales.
        this.actor.text_direction = Clutter.TextDirection.LTR;

        this._keyboardNotifyId = this._keyboardController.connect('active-group', this._onGroupChanged.bind(this));
        this._keyboardGroupsChangedId = this._keyboardController.connect('groups-changed', this._onKeyboardGroupsChanged.bind(this));
        this._keyboardStateId = this._keyboardController.connect('panel-state', this._onKeyboardStateChanged.bind(this));
        this._keypadVisibleId = this._keyboardController.connect('keypad-visible', this._onKeypadVisible.bind(this));
        this._focusNotifyId = global.stage.connect('notify::key-focus', this._onKeyFocusChanged.bind(this));

        if (Meta.is_wayland_compositor())
            this._emojiKeyVisibleId = this._keyboardController.connect('emoji-visible', this._onEmojiKeyVisible.bind(this));

        this._relayout();
    }

    _onKeyFocusChanged() {
        let focus = global.stage.key_focus;

        // Showing an extended key popup and clicking a key from the extended keys
        // will grab focus, but ignore that
        let extendedKeysWereFocused = this._focusInExtendedKeys;
        this._focusInExtendedKeys = focus && (focus._extended_keys || focus.extended_key);
        if (this._focusInExtendedKeys || extendedKeysWereFocused)
            return;

        if (!(focus instanceof Clutter.Text)) {
            this.hide();
            return;
        }

        if (!this._showIdleId) {
            this._showIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.show(Main.layoutManager.focusIndex);
                this._showIdleId = 0;
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(this._showIdleId, '[gnome-shell] this.show');
        }
    }

    _createLayersForGroup(groupName) {
        let keyboardModel = new KeyboardModel(groupName);
        let layers = {};
        let levels = keyboardModel.getLevels();
        for (let i = 0; i < levels.length; i++) {
            let currentLevel = levels[i];
            /* There are keyboard maps which consist of 3 levels (no uppercase,
             * basically). We however make things consistent by skipping that
             * second level.
             */
            let level = (i >= 1 && levels.length == 3) ? i + 1 : i;

            let layout = new KeyContainer();
            layout.shiftKeys = [];

            this._loadRows(currentLevel, level, levels.length, layout);
            layers[level] = layout;
            this._aspectContainer.add_child(layout);
            layout.layoutButtons(this._aspectContainer);

            layout.hide();
        }

        return layers;
    }

    _ensureKeysForGroup(group) {
        if (!this._groups[group])
            this._groups[group] = this._createLayersForGroup(group);
    }

    _addRowKeys(keys, layout) {
        for (let i = 0; i < keys.length; ++i) {
            let key = keys[i];
            let button = new Key(key.shift(), key);

            /* Space key gets special width, dependent on the number of surrounding keys */
            if (button.key == ' ')
                button.setWidth(keys.length <= 3 ? 5 : 3);

            button.connect('pressed', (actor, keyval, str) => {
                if (!Main.inputMethod.currentFocus ||
                    !this._keyboardController.commitString(str, true)) {
                    if (keyval != 0) {
                        this._keyboardController.keyvalPress(keyval);
                        button._keyvalPress = true;
                    }
                }
            });
            button.connect('released', (actor, keyval, _str) => {
                if (keyval != 0) {
                    if (button._keyvalPress)
                        this._keyboardController.keyvalRelease(keyval);
                    button._keyvalPress = false;
                }

                if (!this._latched)
                    this._setActiveLayer(0);
            });

            layout.appendKey(button.actor, button.keyButton.keyWidth);
        }
    }

    _popupLanguageMenu(keyActor) {
        if (this._languagePopup)
            this._languagePopup.destroy();

        this._languagePopup = new LanguageSelectionPopup(keyActor);
        Main.layoutManager.addTopChrome(this._languagePopup.actor);
        this._languagePopup.open(true);
    }

    _loadDefaultKeys(keys, layout, numLevels, numKeys) {
        let extraButton;
        for (let i = 0; i < keys.length; i++) {
            let key = keys[i];
            let keyval = key.keyval;
            let switchToLevel = key.level;
            let action = key.action;

            /* Skip emoji button if necessary */
            if (!this._emojiKeyVisible && action == 'emoji')
                continue;

            extraButton = new Key(key.label || '', []);

            extraButton.keyButton.add_style_class_name('default-key');
            if (key.extraClassName != null)
                extraButton.keyButton.add_style_class_name(key.extraClassName);
            if (key.width != null)
                extraButton.setWidth(key.width);

            let actor = extraButton.keyButton;

            extraButton.connect('pressed', () => {
                if (switchToLevel != null) {
                    this._setActiveLayer(switchToLevel);
                    // Shift only gets latched on long press
                    this._latched = (switchToLevel != 1);
                } else if (keyval != null) {
                    this._keyboardController.keyvalPress(keyval);
                }
            });
            extraButton.connect('released', () => {
                if (keyval != null)
                    this._keyboardController.keyvalRelease(keyval);
                else if (action == 'hide')
                    this.hide();
                else if (action == 'languageMenu')
                    this._popupLanguageMenu(actor);
                else if (action == 'emoji')
                    this._toggleEmoji();
            });

            if (switchToLevel == 0) {
                layout.shiftKeys.push(extraButton);
            } else if (switchToLevel == 1) {
                extraButton.connect('long-press', () => {
                    this._latched = true;
                    this._setCurrentLevelLatched(this._currentPage, this._latched);
                });
            }

            /* Fixup default keys based on the number of levels/keys */
            if (switchToLevel == 1 && numLevels == 3) {
                // Hide shift key if the keymap has no uppercase level
                if (key.right) {
                    /* Only hide the key actor, so the container still takes space */
                    extraButton.keyButton.hide();
                } else {
                    extraButton.actor.hide();
                }
                extraButton.setWidth(1.5);
            } else if (key.right && numKeys > 8) {
                extraButton.setWidth(2);
            } else if (keyval == Clutter.KEY_Return && numKeys > 9) {
                extraButton.setWidth(1.5);
            } else if (!this._emojiKeyVisible && (action == 'hide' || action == 'languageMenu')) {
                extraButton.setWidth(1.5);
            }

            layout.appendKey(extraButton.actor, extraButton.keyButton.keyWidth);
        }
    }

    _updateCurrentPageVisible() {
        if (this._currentPage)
            this._currentPage.visible = !this._emojiActive && !this._keypadVisible;
    }

    _setEmojiActive(active) {
        this._emojiActive = active;
        this._emojiSelection.actor.visible = this._emojiActive;
        this._updateCurrentPageVisible();
    }

    _toggleEmoji() {
        this._setEmojiActive(!this._emojiActive);
    }

    _setCurrentLevelLatched(layout, latched) {
        for (let i = 0; i < layout.shiftKeys.length; i++) {
            let key = layout.shiftKeys[i];
            key.setLatched(latched);
        }
    }

    _getDefaultKeysForRow(row, numRows, level) {
        /* The first 2 rows in defaultKeysPre/Post belong together with
         * the first 2 rows on each keymap. On keymaps that have more than
         * 4 rows, the last 2 default key rows must be respectively
         * assigned to the 2 last keymap ones.
         */
        if (row < 2) {
            return [defaultKeysPre[level][row], defaultKeysPost[level][row]];
        } else if (row >= numRows - 2) {
            let defaultRow = row - (numRows - 2) + 2;
            return [defaultKeysPre[level][defaultRow], defaultKeysPost[level][defaultRow]];
        } else {
            return [null, null];
        }
    }

    _mergeRowKeys(layout, pre, row, post, numLevels) {
        if (pre != null)
            this._loadDefaultKeys(pre, layout, numLevels, row.length);

        this._addRowKeys(row, layout);

        if (post != null)
            this._loadDefaultKeys(post, layout, numLevels, row.length);
    }

    _loadRows(model, level, numLevels, layout) {
        let rows = model.rows;
        for (let i = 0; i < rows.length; ++i) {
            layout.appendRow();
            let [pre, post] = this._getDefaultKeysForRow(i, rows.length, level);
            this._mergeRowKeys (layout, pre, rows[i], post, numLevels);
        }
    }

    _getGridSlots() {
        let numOfHorizSlots = 0, numOfVertSlots;
        let rows = this._currentPage.get_children();
        numOfVertSlots = rows.length;

        for (let i = 0; i < rows.length; ++i) {
            let keyboardRow = rows[i];
            let keys = keyboardRow.get_children();

            numOfHorizSlots = Math.max(numOfHorizSlots, keys.length);
        }

        return [numOfHorizSlots, numOfVertSlots];
    }

    _relayout() {
        let monitor = Main.layoutManager.keyboardMonitor;

        if (this.actor == null || monitor == null)
            return;

        let maxHeight = monitor.height / 3;
        this.actor.width = monitor.width;
        this.actor.height = maxHeight;
    }

    _onGroupChanged() {
        this._ensureKeysForGroup(this._keyboardController.getCurrentGroup());
        this._setActiveLayer(0);
    }

    _onKeyboardGroupsChanged() {
        let nonGroupActors = [this._emojiSelection.actor, this._keypad.actor];
        this._aspectContainer.get_children().filter(c => !nonGroupActors.includes(c)).forEach(c => {
            c.destroy();
        });

        this._groups = {};
        this._onGroupChanged();
    }

    _onKeypadVisible(controller, visible) {
        if (visible == this._keypadVisible)
            return;

        this._keypadVisible = visible;
        this._keypad.actor.visible = this._keypadVisible;
        this._updateCurrentPageVisible();
    }

    _onEmojiKeyVisible(controller, visible) {
        if (visible == this._emojiKeyVisible)
            return;

        this._emojiKeyVisible = visible;
        /* Rebuild keyboard widgetry to include emoji button */
        this._onKeyboardGroupsChanged();
    }

    _onKeyboardStateChanged(controller, state) {
        let enabled;
        if (state == Clutter.InputPanelState.OFF)
            enabled = false;
        else if (state == Clutter.InputPanelState.ON)
            enabled = true;
        else if (state == Clutter.InputPanelState.TOGGLE)
            enabled = (this._keyboardVisible == false);
        else
            return;

        if (enabled)
            this.show(Main.layoutManager.focusIndex);
        else
            this.hide();
    }

    _setActiveLayer(activeLevel) {
        let activeGroupName = this._keyboardController.getCurrentGroup();
        let layers = this._groups[activeGroupName];
        let currentPage = layers[activeLevel];

        if (this._currentPage == currentPage) {
            this._updateCurrentPageVisible();
            return;
        }

        if (this._currentPage != null) {
            this._setCurrentLevelLatched(this._currentPage, false);
            this._currentPage.disconnect(this._currentPage._destroyID);
            this._currentPage.hide();
            delete this._currentPage._destroyID;
        }

        this._currentPage = currentPage;
        this._currentPage._destroyID = this._currentPage.connect('destroy', () => {
            this._currentPage = null;
        });
        this._updateCurrentPageVisible();
    }

    shouldTakeEvent(event) {
        let actor = event.get_source();
        return Main.layoutManager.keyboardBox.contains(actor) ||
               !!actor._extended_keys || !!actor.extended_key;
    }

    _clearKeyboardRestTimer() {
        if (!this._keyboardRestingId)
            return;
        GLib.source_remove(this._keyboardRestingId);
        this._keyboardRestingId = 0;
    }

    show(monitor) {
        if (!this._enabled)
            return;

        this._clearShowIdle();
        this._keyboardRequested = true;

        if (this._keyboardVisible) {
            if (monitor != Main.layoutManager.keyboardIndex) {
                Main.layoutManager.keyboardIndex = monitor;
                this._relayout();
            }
            return;
        }

        this._clearKeyboardRestTimer();
        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                                   KEYBOARD_REST_TIME,
                                                   () => {
                                                       this._clearKeyboardRestTimer();
                                                       this._show(monitor);
                                                       return GLib.SOURCE_REMOVE;
                                                   });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _show(monitor) {
        if (!this._keyboardRequested)
            return;

        Main.layoutManager.keyboardIndex = monitor;
        this._relayout();
        Main.layoutManager.showKeyboard();

        this._setEmojiActive(false);

        if (this._delayedAnimFocusWindow) {
            this._setAnimationWindow(this._delayedAnimFocusWindow);
            this._delayedAnimFocusWindow = null;
        }
    }

    hide() {
        if (!this._enabled)
            return;

        this._clearShowIdle();
        this._keyboardRequested = false;

        if (!this._keyboardVisible)
            return;

        this._clearKeyboardRestTimer();
        this._keyboardRestingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                                                   KEYBOARD_REST_TIME,
                                                   () => {
                                                       this._clearKeyboardRestTimer();
                                                       this._hide();
                                                       return GLib.SOURCE_REMOVE;
                                                   });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _hide() {
        if (this._keyboardRequested)
            return;

        Main.layoutManager.hideKeyboard();
        this.setCursorLocation(null);
    }

    resetSuggestions() {
        if (this._suggestions)
            this._suggestions.clear();
    }

    addSuggestion(text, callback) {
        if (!this._suggestions)
            return;
        this._suggestions.add(text, callback);
        this._suggestions.actor.show();
    }

    _clearShowIdle() {
        if (!this._showIdleId)
            return;
        GLib.source_remove(this._showIdleId);
        this._showIdleId = 0;
    }

    _windowSlideAnimationComplete(window, delta) {
        // Synchronize window positions again.
        let frameRect = window.get_frame_rect();
        frameRect.y += delta;
        window.move_frame(true, frameRect.x, frameRect.y);
    }

    _animateWindow(window, show) {
        let windowActor = window.get_compositor_private();
        let deltaY = Main.layoutManager.keyboardBox.height;
        if (!windowActor)
            return;

        if (show) {
            windowActor.ease({
                y: windowActor.y - deltaY,
                duration: Layout.KEYBOARD_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this._windowSlideAnimationComplete(window, -deltaY);
                }
            });
        } else {
            windowActor.ease({
                y: windowActor.y + deltaY,
                duration: Layout.KEYBOARD_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._windowSlideAnimationComplete(window, deltaY);
                }
            });
        }
    }

    _setAnimationWindow(window) {
        if (this._animFocusedWindow == window)
            return;

        if (this._animFocusedWindow)
            this._animateWindow(this._animFocusedWindow, false);
        if (window)
            this._animateWindow(window, true);

        this._animFocusedWindow = window;
    }

    setCursorLocation(window, x, y, w, h) {
        let monitor = Main.layoutManager.keyboardMonitor;

        if (window && monitor) {
            let keyboardHeight = Main.layoutManager.keyboardBox.height;

            if (y + h >= monitor.y + monitor.height - keyboardHeight) {
                if (this._keyboardVisible)
                    this._setAnimationWindow(window);
                else
                    this._delayedAnimFocusWindow = window;
            } else if (y < keyboardHeight) {
                this._delayedAnimFocusWindow = null;
                this._setAnimationWindow(null);
            }
        } else {
            this._setAnimationWindow(null);
        }

        this._oskFocusWindow = window;
    }
};

var KeyboardController = class {
    constructor() {
        let deviceManager = Clutter.DeviceManager.get_default();
        this._virtualDevice = deviceManager.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._inputSourceManager = InputSourceManager.getInputSourceManager();
        this._sourceChangedId = this._inputSourceManager.connect('current-source-changed',
                                                                 this._onSourceChanged.bind(this));
        this._sourcesModifiedId = this._inputSourceManager.connect ('sources-changed',
                                                                    this._onSourcesModified.bind(this));
        this._currentSource = this._inputSourceManager.currentSource;

        Main.inputMethod.connect('notify::content-purpose',
                                 this._onContentPurposeHintsChanged.bind(this));
        Main.inputMethod.connect('notify::content-hints',
                                 this._onContentPurposeHintsChanged.bind(this));
        Main.inputMethod.connect('input-panel-state', (o, state) => {
            this.emit('panel-state', state);
        });
    }

    _onSourcesModified() {
        this.emit('groups-changed');
    }

    _onSourceChanged(inputSourceManager, _oldSource) {
        let source = inputSourceManager.currentSource;
        this._currentSource = source;
        this.emit('active-group', source.id);
    }

    _onContentPurposeHintsChanged(method) {
        let purpose = method.content_purpose;
        let emojiVisible = false;
        let keypadVisible = false;

        if (purpose == Clutter.InputContentPurpose.NORMAL ||
            purpose == Clutter.InputContentPurpose.ALPHA ||
            purpose == Clutter.InputContentPurpose.PASSWORD ||
            purpose == Clutter.InputContentPurpose.TERMINAL)
            emojiVisible = true;
        if (purpose == Clutter.InputContentPurpose.DIGITS ||
            purpose == Clutter.InputContentPurpose.NUMBER ||
            purpose == Clutter.InputContentPurpose.PHONE)
            keypadVisible = true;

        this.emit('emoji-visible', emojiVisible);
        this.emit('keypad-visible', keypadVisible);
    }

    getGroups() {
        let inputSources = this._inputSourceManager.inputSources;
        let groups = [];

        for (let i in inputSources) {
            let is = inputSources[i];
            groups[is.index] = is.xkbId;
        }

        return groups;
    }

    getCurrentGroup() {
        return this._currentSource.xkbId;
    }

    commitString(string, fromKey) {
        if (string == null)
            return false;
        /* Let ibus methods fall through keyval emission */
        if (fromKey && this._currentSource.type == InputSourceManager.INPUT_SOURCE_TYPE_IBUS)
            return false;

        Main.inputMethod.commit(string);
        return true;
    }

    keyvalPress(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time(),
                                          keyval, Clutter.KeyState.PRESSED);
    }

    keyvalRelease(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time(),
                                          keyval, Clutter.KeyState.RELEASED);
    }
};
Signals.addSignalMethods(KeyboardController.prototype);
