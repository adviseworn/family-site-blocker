package io.gitlab.adviseworn.familysiteblocker

import android.content.Context
import android.content.SharedPreferences
import androidx.core.app.NotificationManagerCompat
import io.gitlab.adviseworn.familysiteblocker.downloads.DownloadService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import mozilla.components.browser.domains.autocomplete.ShippedDomainsProvider
import mozilla.components.browser.engine.gecko.GeckoEngine
import mozilla.components.browser.engine.gecko.fetch.GeckoViewFetchClient
import mozilla.components.browser.errorpages.ErrorPages
import mozilla.components.browser.icons.BrowserIcons
import mozilla.components.browser.session.storage.SessionStorage
import mozilla.components.browser.state.engine.EngineMiddleware
import mozilla.components.browser.state.engine.middleware.SessionPrioritizationMiddleware
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.browser.storage.sync.PlacesHistoryStorage
import mozilla.components.browser.thumbnails.ThumbnailsMiddleware
import mozilla.components.browser.thumbnails.storage.ThumbnailStorage
import mozilla.components.concept.engine.DefaultSettings
import mozilla.components.concept.engine.Engine
import mozilla.components.concept.engine.EngineSession
import mozilla.components.concept.engine.EngineSession.TrackingProtectionPolicy
import mozilla.components.concept.engine.mediaquery.PreferredColorScheme
import mozilla.components.concept.engine.request.ErrorType
import mozilla.components.concept.engine.request.RequestInterceptor
import mozilla.components.concept.fetch.Client
import mozilla.components.feature.contextmenu.ContextMenuUseCases
import mozilla.components.feature.downloads.DefaultFileSizeFormatter
import mozilla.components.feature.downloads.DownloadEstimator
import mozilla.components.feature.downloads.DownloadMiddleware
import mozilla.components.feature.downloads.DownloadsUseCases
import mozilla.components.feature.downloads.FileSizeFormatter
import mozilla.components.feature.intent.processing.TabIntentProcessor
import mozilla.components.feature.prompts.PromptMiddleware
import mozilla.components.feature.prompts.file.FileUploadsDirCleaner
import mozilla.components.feature.search.SearchUseCases
import mozilla.components.feature.search.middleware.SearchMiddleware
import mozilla.components.feature.search.region.RegionMiddleware
import mozilla.components.feature.session.HistoryDelegate
import mozilla.components.feature.session.SessionUseCases
import mozilla.components.feature.session.middleware.LastAccessMiddleware
import mozilla.components.feature.session.middleware.undo.UndoMiddleware
import mozilla.components.feature.sitepermissions.OnDiskSitePermissionsStorage
import mozilla.components.feature.tabs.TabsUseCases
import mozilla.components.feature.webcompat.WebCompatFeature
import mozilla.components.service.location.LocationService
import mozilla.components.support.base.android.NotificationsDelegate
import mozilla.components.support.base.log.logger.Logger
import mozilla.components.support.utils.DefaultDateTimeProvider
import mozilla.components.support.utils.DefaultDownloadFileUtils
import org.mozilla.geckoview.GeckoRuntime
import org.mozilla.geckoview.GeckoRuntimeSettings

/** Everything the browser is made of, created once per process and only when first used. */
class Components(private val applicationContext: Context) {
    private val logger = Logger("Components")

    val applicationScope: CoroutineScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    val preferences: SharedPreferences =
        applicationContext.getSharedPreferences("family_site_blocker", Context.MODE_PRIVATE)

    /** Which add-on pages open in a tab: Family Site Blocker's, and uBlock Origin's stopped page. */
    val addOnPages = AddOnPages(preferences)

    /**
     * Gecko, set up so that nothing in the app can switch the add-on off: no about:config, no add-on installs
     * from web pages, no remote debugging.
     */
    private val runtime: GeckoRuntime by lazy {
        val settings = GeckoRuntimeSettings.Builder()
            .aboutConfigEnabled(false)
            .extensionsWebAPIEnabled(false)
            .remoteDebuggingEnabled(false)
            .consoleOutput(BuildConfig.DEBUG)
            .build()
        GeckoRuntime.create(applicationContext, settings)
    }

    private val lazyHistoryStorage = lazy { PlacesHistoryStorage(applicationContext) }
    val historyStorage: PlacesHistoryStorage by lazy { lazyHistoryStorage.value }

    private val engineSettings: DefaultSettings by lazy {
        DefaultSettings().apply {
            historyTrackingDelegate = HistoryDelegate(lazyHistoryStorage)
            remoteDebuggingEnabled = false
            supportMultipleWindows = true
            trackingProtectionPolicy = TrackingProtectionPolicy.recommended()
            preferredColorScheme = PreferredColorScheme.System
            requestInterceptor = pages
        }
    }

    /** What the app has to say about a page: before Gecko goes to it, and when it did not open. */
    private val pages = object : RequestInterceptor {
        /** Asked about the addresses the app itself sends a tab to as well: a typed one is one of those. */
        override fun interceptsAppInitiatedRequests() = true

        /**
         * A page of an add-on opens only if [AddOnPages] lets it, which keeps uBlock Origin's settings shut.
         * A frame inside a page is left to Gecko: no web page can frame an add-on's settings, and uBlock
         * Origin puts a blank of its own into a frame it has emptied.
         */
        override fun onLoadRequest(
            engineSession: EngineSession,
            uri: String,
            lastUri: String?,
            hasUserGesture: Boolean,
            isSameDomain: Boolean,
            isRedirect: Boolean,
            isDirectNavigation: Boolean,
            isSubframeRequest: Boolean,
        ): RequestInterceptor.InterceptionResponse? =
            if (isSubframeRequest || addOnPages.opens(uri)) {
                null
            } else {
                logger.info("An add-on's page that does not open here was asked for")
                RequestInterceptor.InterceptionResponse.Deny
            }

        /**
         * A page that does not open (no network, no such site, a certificate that is not right) says so, on
         * Mozilla's own page for it. Without this the screen stays blank under the address.
         */
        override fun onErrorRequest(session: EngineSession, errorType: ErrorType, uri: String?): RequestInterceptor.ErrorResponse =
            RequestInterceptor.ErrorResponse(ErrorPages.createUrlEncodedErrorPage(applicationContext, errorType, uri))
    }

    /**
     * Gecko with Family Site Blocker built in, and uBlock Origin beside it for the advertisements. Both come
     * from the APK's assets and have no off switch.
     */
    val engine: Engine by lazy {
        GeckoEngine(applicationContext, engineSettings, runtime).also { engine ->
            engine.installBuiltInWebExtension(
                id = FamilySiteBlocker.EXTENSION_ID,
                url = FamilySiteBlocker.EXTENSION_URL,
                onSuccess = { extension ->
                    FamilySiteBlocker.onInstalled(extension)
                    addOnPages.reported()
                    AddOnBridge.listen(applicationContext, extension)
                },
                onError = { throwable -> logger.error("Could not install the Family Site Blocker add-on", throwable) },
            )
            engine.installBuiltInWebExtension(
                id = UBlockOrigin.EXTENSION_ID,
                url = UBlockOrigin.EXTENSION_URL,
                onSuccess = { extension ->
                    UBlockOrigin.onInstalled(extension)
                    addOnPages.reported()
                },
                onError = { throwable -> logger.error("Could not install uBlock Origin", throwable) },
            )
            WebCompatFeature.install(engine)
        }
    }

    val client: Client by lazy { GeckoViewFetchClient(applicationContext, runtime) }
    val icons: BrowserIcons by lazy { BrowserIcons(applicationContext, client) }
    val sessionStorage: SessionStorage by lazy {
        SessionStorage(applicationContext, engine, applicationScope = applicationScope)
    }
    val permissionStorage: OnDiskSitePermissionsStorage by lazy { OnDiskSitePermissionsStorage(applicationContext) }
    val thumbnailStorage: ThumbnailStorage by lazy { ThumbnailStorage(applicationContext) }
    val fileUploadsDirCleaner: FileUploadsDirCleaner by lazy {
        FileUploadsDirCleaner(applicationScope) { applicationContext.cacheDir }
    }
    val notificationsDelegate: NotificationsDelegate by lazy {
        NotificationsDelegate(NotificationManagerCompat.from(applicationContext))
    }

    val store: BrowserStore by lazy {
        BrowserStore(
            middleware = listOf(
                DownloadMiddleware(
                    applicationContext = applicationContext,
                    downloadServiceClass = DownloadService::class.java,
                    deleteFileFromStorage = { false },
                    downloadFileUtils = DefaultDownloadFileUtils(context = applicationContext),
                ),
                ThumbnailsMiddleware(thumbnailStorage),
                UndoMiddleware(),
                RegionMiddleware(applicationContext, LocationService.default(), applicationScope = applicationScope),
                SearchMiddleware(applicationContext),
                LastAccessMiddleware(),
                PromptMiddleware(),
                SessionPrioritizationMiddleware(),
                AddOnPagesWatch(addOnPages),
            ) + EngineMiddleware.create(engine),
        )
    }

    val sessionUseCases: SessionUseCases by lazy { SessionUseCases(store) }
    val tabsUseCases: TabsUseCases by lazy { TabsUseCases(store) }
    val searchUseCases: SearchUseCases by lazy { SearchUseCases(store, tabsUseCases, sessionUseCases) }
    val defaultSearchUseCase: (String) -> Unit by lazy {
        { searchTerms: String ->
            searchUseCases.defaultSearch.invoke(searchTerms = searchTerms, searchEngine = null, parentSessionId = null)
        }
    }
    val downloadsUseCases: DownloadsUseCases by lazy {
        DownloadsUseCases(store = store, downloadFileUtils = DefaultDownloadFileUtils(context = applicationContext))
    }
    val contextMenuUseCases: ContextMenuUseCases by lazy { ContextMenuUseCases(store) }
    val tabIntentProcessor: TabIntentProcessor by lazy {
        TabIntentProcessor(tabsUseCases, searchUseCases.newTabSearch, applicationScope = applicationScope)
    }
    val shippedDomainsProvider: ShippedDomainsProvider by lazy {
        ShippedDomainsProvider(1).also { it.initialize(applicationContext) }
    }
    val fileSizeFormatter: FileSizeFormatter by lazy { DefaultFileSizeFormatter(applicationContext) }
    val downloadEstimator: DownloadEstimator by lazy { DownloadEstimator(dateTimeProvider = DefaultDateTimeProvider()) }
}
