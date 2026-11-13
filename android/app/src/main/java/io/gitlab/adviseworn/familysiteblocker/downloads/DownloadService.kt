package io.gitlab.adviseworn.familysiteblocker.downloads

import io.gitlab.adviseworn.familysiteblocker.ext.components
import mozilla.components.browser.state.store.BrowserStore
import mozilla.components.feature.downloads.AbstractFetchDownloadService
import mozilla.components.feature.downloads.DefaultPackageNameProvider
import mozilla.components.feature.downloads.DownloadEstimator
import mozilla.components.feature.downloads.FileSizeFormatter
import mozilla.components.feature.downloads.PackageNameProvider
import mozilla.components.feature.downloads.filewriter.DefaultDownloadFileWriter
import mozilla.components.feature.downloads.filewriter.DownloadFileWriter
import mozilla.components.support.base.android.NotificationsDelegate
import mozilla.components.support.utils.DefaultDownloadFileUtils
import mozilla.components.support.utils.DownloadFileUtils

/** Downloads run in this foreground service, with a notification, so they finish when the app is in the background. */
class DownloadService : AbstractFetchDownloadService() {
    override val httpClient by lazy { components.client }
    override val store: BrowserStore by lazy { components.store }
    override val notificationsDelegate: NotificationsDelegate by lazy { components.notificationsDelegate }
    override val fileSizeFormatter: FileSizeFormatter by lazy { components.fileSizeFormatter }
    override val downloadEstimator: DownloadEstimator by lazy { components.downloadEstimator }
    override val packageNameProvider: PackageNameProvider by lazy { DefaultPackageNameProvider(applicationContext) }
    override val downloadFileUtils: DownloadFileUtils by lazy { DefaultDownloadFileUtils(context = applicationContext) }
    override val downloadFileWriter: DownloadFileWriter by lazy {
        DefaultDownloadFileWriter(context = applicationContext, downloadFileUtils = downloadFileUtils)
    }
}
