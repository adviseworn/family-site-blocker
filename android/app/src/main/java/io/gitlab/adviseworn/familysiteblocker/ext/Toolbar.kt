package io.gitlab.adviseworn.familysiteblocker.ext

import androidx.appcompat.widget.Toolbar
import androidx.core.content.ContextCompat
import androidx.core.view.forEach
import io.gitlab.adviseworn.familysiteblocker.R

/**
 * Gives the bar's back arrow and the icons of its menu the colour of the bar's title. Mozilla's icons are drawn
 * white, to be tinted, and this kind of bar takes no tint for them from the layout or from the menu's file: on
 * the light theme's white bar they were there to tap and could not be seen. Call it once the bar has its menu.
 */
fun Toolbar.tintIcons() {
    val colour = ContextCompat.getColor(context, R.color.fsb_toolbar_text)
    navigationIcon = navigationIcon?.mutate()?.apply { setTint(colour) }
    menu.forEach { item -> item.icon = item.icon?.mutate()?.apply { setTint(colour) } }
}
