package dev.breakremote.agent.ui

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val view = TextView(this).apply {
            text = getString(
                dev.breakremote.agent.R.string.app_name
            ) + "\n" + dev.breakremote.agent.BuildConfig.RELAY_URL
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#101418"))
        }
        setContentView(view)
    }
}
