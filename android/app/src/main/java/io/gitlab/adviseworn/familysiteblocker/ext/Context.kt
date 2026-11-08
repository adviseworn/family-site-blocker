package io.gitlab.adviseworn.familysiteblocker.ext

import android.content.Context
import androidx.fragment.app.Fragment
import io.gitlab.adviseworn.familysiteblocker.BrowserApplication
import io.gitlab.adviseworn.familysiteblocker.Components

val Context.application: BrowserApplication
    get() = applicationContext as BrowserApplication

val Context.components: Components
    get() = application.components

val Fragment.components: Components
    get() = requireContext().components
